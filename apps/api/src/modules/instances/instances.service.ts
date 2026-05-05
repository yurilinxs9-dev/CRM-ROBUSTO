import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import type { AuthUser } from '../../common/types/auth-user';
import { UserRole } from '../../common/types/roles';
import { hashTruncated } from '../../common/utils/hash-truncated';

interface UazApiCreateResponse {
  instance: {
    id: string;
    token: string;
    name: string;
    status: string;
    qrcode?: string;
  };
}

interface UazApiConnectResponse {
  instance: {
    qrcode?: string;
    status: string;
  };
  status: {
    connected: boolean;
    loggedIn: boolean;
    jid: string | null;
  };
}

export interface UazApiStatusResponse {
  instance: {
    status: string;
    profileName?: string;
    owner?: string;
    qrcode?: string;
  };
  status: {
    connected: boolean;
    loggedIn: boolean;
    jid: string | null;
  };
}

interface InstanceConfig {
  uazapi_token?: string;
  uazapi_id?: string;
  [key: string]: unknown;
}

@Injectable()
export class InstancesService implements OnModuleInit {
  private readonly logger = new Logger(InstancesService.name);
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly webhookUrl: string;
  private readonly publicUrl: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.adminToken = this.config.get<string>('UAZAPI_ADMIN_TOKEN', '');
    this.publicUrl = this.config.get<string>('WEBHOOK_PUBLIC_URL', 'http://crm-backend:3001');
    this.webhookUrl = `${this.publicUrl}/api/webhook/uazapi`;
  }

  /**
   * Auto-heal de webhook URLs no startup.
   *
   * Sempre que o backend sobe, varre instâncias com token UazAPI, lê o
   * webhook configurado lá fora e re-aponta pra `WEBHOOK_PUBLIC_URL` atual
   * caso esteja diferente. Garante que se a URL pública mudar (migração de
   * VPS, troca de tunnel, rotação DuckDNS), nenhuma instância fica órfã
   * postando webhook pra um endpoint morto — bug que custou várias horas
   * de debug quando a sessão trycloudflare expirou.
   *
   * Roda em paralelo (limit 5) e ignora instâncias com token revogado
   * (401 = legítimo, não tenta arrumar).
   */
  async onModuleInit(): Promise<void> {
    // Defer pra não bloquear bootstrap. 5s é suficiente pra Nest terminar de
    // mapear todas rotas + abrir HTTP listener.
    setTimeout(() => {
      this.syncAllWebhookUrls().catch((err: unknown) =>
        this.logger.warn(`syncAllWebhookUrls falhou: ${String(err)}`),
      );
    }, 5000);
  }

  async syncAllWebhookUrls(): Promise<{ checked: number; updated: number; skipped: number }> {
    const instances = await this.prisma.whatsappInstance.findMany({
      select: { id: true, nome: true, config: true, webhook_secret: true },
    });
    const targets = instances
      .map((i) => {
        const cfg = (i.config ?? {}) as InstanceConfig;
        if (!cfg.uazapi_token) return null;
        if (!i.webhook_secret) {
          this.logger.warn({
            event: 'instances.healWebhooks.skip_no_secret',
            instance_name_hash: hashTruncated(i.nome),
          });
          return null;
        }
        return {
          id: i.id,
          nome: i.nome,
          token: cfg.uazapi_token,
          webhookSecret: i.webhook_secret,
        };
      })
      .filter(
        (x): x is {
          id: string;
          nome: string;
          token: string;
          webhookSecret: string;
        } => !!x,
      );

    let checked = 0;
    let updated = 0;
    let skipped = 0;
    const events = ['messages', 'messages_update', 'connection', 'presence', 'contacts', 'chats'];

    // Limita 5 chamadas concorrentes pra não martelar UazAPI.
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      while (queue.length) {
        const t = queue.shift();
        if (!t) break;
        checked++;
        try {
          const { data } = await firstValueFrom(
            this.http.get<Array<{ url?: string }>>(`${this.baseUrl}/webhook`, {
              headers: this.headers(t.token),
              timeout: 8000,
            }),
          );
          const currentUrl = Array.isArray(data) && data[0]?.url ? data[0].url : '';
          const expectedUrl = this.buildAuthenticatedWebhookUrl(
            t.id,
            t.webhookSecret,
          );
          if (currentUrl === expectedUrl) {
            skipped++;
            continue;
          }
          await firstValueFrom(
            this.http.post(
              `${this.baseUrl}/webhook`,
              {
                url: expectedUrl,
                enabled: true,
                events,
                addUrlEvents: false,
                addUrlTypesMessages: false,
                excludeMessages: [],
              },
              { headers: this.headers(t.token), timeout: 8000 },
            ),
          );
          updated++;
          this.logger.log({
            event: 'instances.healWebhooks.url_updated',
            instance_name_hash: hashTruncated(t.nome),
          });
        } catch (err: unknown) {
          // 401 = token stale (instância revogada/desconectada). Skip.
          skipped++;
          const msg = (err as { response?: { status?: number } })?.response?.status === 401
            ? '401 token revogado'
            : String((err as Error)?.message ?? err);
          this.logger.debug(`webhook re-sync ${t.nome} skip: ${msg}`);
        }
      }
    };

    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    this.logger.log(
      `Webhook sync completo: checked=${checked} updated=${updated} skipped=${skipped}`,
    );
    return { checked, updated, skipped };
  }

  private headers(instanceToken: string): Record<string, string> {
    return { token: instanceToken };
  }

  private adminHeaders(): Record<string, string> {
    return { admintoken: this.adminToken };
  }

  private buildAuthenticatedWebhookUrl(
    instanceId: string,
    webhookSecret: string,
  ): string {
    return `${this.publicUrl}/api/webhook/uazapi/${instanceId}/${webhookSecret}`;
  }

  private async loadInstanceTokenScoped(nome: string, tenantId: string): Promise<string> {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: tenantId },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException(`Token UazAPI ausente para instancia ${nome}`);
    return token;
  }

  async findAll(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });
    const hiddenIds = (
      await this.prisma.instanceHidden.findMany({
        where: { user_id: user.id, tenant_id: user.tenantId },
        select: { instance_id: true },
      })
    ).map((h) => h.instance_id);

    // Modo Compartilhado: todos veem o mesmo número (a instância é da equipe,
    // não pessoal). Modo Individual: cada user vê apenas as próprias.
    const ownerFilter = tenant?.pool_enabled ? {} : { owner_user_id: user.id };

    return this.prisma.whatsappInstance.findMany({
      where: {
        tenant_id: user.tenantId,
        ...ownerFilter,
        ...(hiddenIds.length ? { id: { notIn: hiddenIds } } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
  }

  async create(nome: string, user: AuthUser) {
    const { data: createData } = await firstValueFrom(
      this.http.post<UazApiCreateResponse>(
        `${this.baseUrl}/instance/create`,
        { name: nome },
        { headers: this.adminHeaders() },
      ),
    );

    const uazapi_token = createData.instance.token;
    const uazapi_id = createData.instance.id;

    await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/webhook`,
        {
          url: this.webhookUrl,
          enabled: true,
          events: ['messages', 'messages_update', 'connection', 'presence', 'contacts', 'chats'],
          addUrlEvents: false,
          addUrlTypesMessages: false,
          excludeMessages: [],
        },
        { headers: this.headers(uazapi_token) },
      ),
    ).catch((err: unknown) => {
      this.logger.warn(`Falha ao registrar webhook UazAPI para ${nome}: ${String(err)}`);
      return null;
    });

    const existing = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
    });
    if (existing) {
      await this.prisma.whatsappInstance.update({
        where: { id: existing.id },
        data: { status: 'connecting', config: { uazapi_token, uazapi_id } },
      });
    } else {
      await this.prisma.whatsappInstance.create({
        data: {
          nome,
          status: 'connecting',
          config: { uazapi_token, uazapi_id },
          owner_user_id: user.id,
          tenant_id: user.tenantId,
        },
      });
    }

    return { instanceName: nome, status: 'connecting' };
  }

  async getQrCode(nome: string, user: AuthUser) {
    const token = await this.loadInstanceTokenScoped(nome, user.tenantId);
    const { data } = await firstValueFrom(
      this.http.post<UazApiConnectResponse & { connected?: boolean }>(
        `${this.baseUrl}/instance/connect`,
        {},
        { headers: this.headers(token) },
      ),
    );
    const qrcode = data.instance?.qrcode ?? null;
    const isConnected =
      data.status?.connected === true ||
      data.status?.loggedIn === true ||
      (data as { connected?: boolean }).connected === true ||
      data.instance?.status === 'connected';
    if (isConnected || !qrcode) {
      const jid = data.status?.jid ?? null;
      const telefone = jid ? jid.split('@')[0].split(':')[0] : undefined;
      await this.prisma.whatsappInstance.update({
        where: { tenant_id_nome: { tenant_id: user.tenantId, nome } },
        data: {
          status: 'open',
          ultimo_check: new Date(),
          ...(telefone ? { telefone } : {}),
        },
      });
      return { base64: null, alreadyConnected: true };
    }
    return { base64: qrcode, alreadyConnected: false };
  }

  async reconnect(nome: string, user: AuthUser) {
    return this.getQrCode(nome, user);
  }

  async checkStatus(nome: string, user: AuthUser) {
    const token = await this.loadInstanceTokenScoped(nome, user.tenantId);
    const { data } = await firstValueFrom(
      this.http.get<UazApiStatusResponse>(`${this.baseUrl}/instance/status`, {
        headers: this.headers(token),
      }),
    );

    const rawStatus = data.instance?.status ?? 'disconnected';
    const statusMap: Record<string, string> = {
      connected: 'open',
      connecting: 'connecting',
      disconnected: 'disconnected',
    };
    const status = statusMap[rawStatus] ?? rawStatus;

    const jid = data.status?.jid ?? null;
    const telefone = jid ? jid.split('@')[0].split(':')[0] : undefined;

    await this.prisma.whatsappInstance.update({
      where: { tenant_id_nome: { tenant_id: user.tenantId, nome } },
      data: {
        status,
        ultimo_check: new Date(),
        ...(telefone ? { telefone } : {}),
      },
    });
    return data;
  }

  async fetchProfile(
    token: string,
    number: string,
  ): Promise<{ name?: string; imageUrl?: string }> {
    if (!token || !number) return {};
    try {
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.baseUrl}/chat/GetNameAndImageURL`,
          { number, preview: false },
          { headers: this.headers(token), timeout: 15000 },
        ),
      );
      // UazAPI returns: { name, wa_name, wa_contactName, image, imagePreview, ... }
      // Prefer the real WhatsApp contact/profile name over any local labels.
      const name =
        (data?.wa_contactName as string | undefined) ??
        (data?.wa_name as string | undefined) ??
        (data?.name as string | undefined) ??
        (data?.pushName as string | undefined) ??
        (data?.verifiedName as string | undefined);
      const imageUrl =
        (data?.image as string | undefined) ??
        (data?.imagePreview as string | undefined) ??
        (data?.imageUrl as string | undefined) ??
        (data?.profilePictureUrl as string | undefined);
      return {
        name: name && name.trim() ? name.trim() : undefined,
        imageUrl: imageUrl && imageUrl.trim() ? imageUrl.trim() : undefined,
      };
    } catch (err) {
      this.logger.warn(`fetchProfile falhou para ${number}: ${String(err)}`);
      return {};
    }
  }

  /**
   * Marca msgs como lidas no WhatsApp do remetente (check azul no celular
   * nativo) + reseta contador de não lidas no UazAPI. Best-effort: erros
   * só logam, não derrubam o fluxo de leitura local.
   */
  async markChatRead(
    token: string,
    number: string,
    messageIds: string[],
  ): Promise<void> {
    if (!token || !number) return;

    if (messageIds.length > 0) {
      // UazAPI aceita até ~100 ids por chamada. Lotes maiores são raros.
      const batches: string[][] = [];
      for (let i = 0; i < messageIds.length; i += 100) {
        batches.push(messageIds.slice(i, i + 100));
      }
      for (const batch of batches) {
        await firstValueFrom(
          this.http.post(
            `${this.baseUrl}/message/markread`,
            { number, id: batch },
            { headers: this.headers(token), timeout: 10000 },
          ),
        ).catch((err: unknown) => {
          this.logger.warn(
            `markread falhou number=${number} batch=${batch.length}: ${String(err)}`,
          );
          return null;
        });
      }
    }

    // Sincroniza contador de não-lidas no app oficial (sem isso, o badge
    // do WhatsApp Business no celular continua marcando "X não lidas"
    // mesmo após o operador abrir o chat no CRM).
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/chat/read`,
        { number, read: true },
        { headers: this.headers(token), timeout: 10000 },
      ),
    ).catch((err: unknown) => {
      this.logger.warn(`chat/read falhou number=${number}: ${String(err)}`);
      return null;
    });
  }

  async delete(nome: string, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);

    // SUPER_ADMIN sempre faz hard delete (autoridade total no tenant).
    // Não-owner não-admin: só esconde da própria visão. Não toca UazAPI nem
    // deleta DB — número permanece conectado e visível pros outros membros.
    // Owner (criou a instância): apaga de verdade — UazAPI + DB — pra todos.
    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;
    if (instance.owner_user_id !== user.id && !isSuperAdmin) {
      await this.prisma.instanceHidden.upsert({
        where: { user_id_instance_id: { user_id: user.id, instance_id: instance.id } },
        create: {
          user_id: user.id,
          instance_id: instance.id,
          tenant_id: user.tenantId,
        },
        update: {},
      });
      return { hidden: true };
    }

    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;

    if (token) {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl}/instance`, {
          headers: { ...this.adminHeaders(), ...this.headers(token) },
        }),
      ).catch((err: unknown) => {
        this.logger.warn(`Falha ao deletar instancia UazAPI ${nome}: ${String(err)}`);
        return null;
      });
    }

    await this.prisma.whatsappInstance.delete({ where: { id: instance.id } }).catch((err: unknown) => {
      this.logger.warn(`Falha ao deletar instancia DB ${nome}: ${String(err)}`);
      return null;
    });
    return { hidden: false };
  }
}
