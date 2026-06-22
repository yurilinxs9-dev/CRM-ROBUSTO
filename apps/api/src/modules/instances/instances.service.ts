import { Injectable, Logger, NotFoundException, BadRequestException, BadGatewayException, OnModuleInit } from '@nestjs/common';
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
  provider?: 'uazapi' | 'evolution';
  evolution_token?: string;
  evolution_base_url?: string;
  [key: string]: unknown;
}

interface EvoCreateResponse {
  instance?: { instanceName?: string; status?: string };
  hash?: string | { apikey?: string };
  qrcode?: { base64?: string; code?: string };
}

interface EvoConnectResponse {
  base64?: string;
  code?: string;
  qrcode?: { base64?: string; code?: string };
  instance?: { state?: string };
}

@Injectable()
export class InstancesService implements OnModuleInit {
  private readonly logger = new Logger(InstancesService.name);
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly webhookUrl: string;
  private readonly publicUrl: string;
  private readonly evoBaseUrl: string;
  private readonly evoApiKey: string;
  private readonly evoWebhookUrl: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.adminToken = this.config.get<string>('UAZAPI_ADMIN_TOKEN', '');
    this.publicUrl = this.config.get<string>('WEBHOOK_PUBLIC_URL', 'http://crm-backend:3001');
    this.webhookUrl = `${this.publicUrl}/api/webhook/uazapi`;
    this.evoBaseUrl = this.config.get<string>('EVOLUTION_BASE_URL', '');
    this.evoApiKey = this.config.get<string>('EVOLUTION_API_KEY', '');
    this.evoWebhookUrl = `${this.publicUrl}/api/webhook/evolution`;
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

  /**
   * F-02: define o setor que atende o número (destino do round-robin). null
   * volta a cair no setor padrão "Sem Setor". Valida que ambos são do tenant.
   */
  async setSector(instanceId: string, sectorId: string | null, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { id: instanceId, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!instance) throw new NotFoundException('Instância não encontrada');
    if (sectorId) {
      const sector = await this.prisma.sector.findFirst({
        where: { id: sectorId, tenant_id: user.tenantId, active: true },
        select: { id: true },
      });
      if (!sector) throw new BadRequestException('Setor inválido ou inativo');
    }
    await this.prisma.whatsappInstance.update({
      where: { id: instanceId },
      data: { sector_id: sectorId },
    });
    return { ok: true, sector_id: sectorId };
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

  // Importa uma instancia JA existente na UazAPI usando o token dela.
  // Nao cria instancia nova nem registra webhook (pra nao roubar o webhook de
  // outro sistema que use o mesmo numero — o fan-out fica a cargo do aggregator).
  async importByToken(nome: string, uazapiToken: string, user: AuthUser) {
    const nomeTrim = (nome ?? '').trim();
    const token = (uazapiToken ?? '').trim();
    const tokenRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!nomeTrim) throw new BadRequestException('Nome da instancia obrigatorio');
    if (!tokenRe.test(token)) {
      throw new BadRequestException('Token invalido. Cole o Instance Token da UazAPI (formato UUID).');
    }

    // Valida o token consultando o status. Token invalido => UazAPI responde 401.
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

    const existing = await this.prisma.whatsappInstance.findFirst({
      where: { nome: nomeTrim, tenant_id: user.tenantId },
    });
    if (existing) {
      await this.prisma.whatsappInstance.update({
        where: { id: existing.id },
        data: { status, config: { uazapi_token: token, imported: true }, ...(telefone ? { telefone } : {}) },
      });
    } else {
      await this.prisma.whatsappInstance.create({
        data: {
          nome: nomeTrim,
          status,
          config: { uazapi_token: token, imported: true },
          owner_user_id: user.id,
          tenant_id: user.tenantId,
          ...(telefone ? { telefone } : {}),
        },
      });
    }

    return { instanceName: nomeTrim, status };
  }

  /** Headers do servidor Evolution (admin/global). */
  private evoHeaders(apikey?: string): Record<string, string> {
    return { 'Content-Type': 'application/json', apikey: apikey ?? this.evoApiKey };
  }

  private evoEvents(): string[] {
    return [
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'CONTACTS_UPSERT',
      // CHATS_UPDATE: leitura no celular zera unreadCount → sincroniza badge no CRM.
      'CHATS_UPDATE',
    ];
  }

  /**
   * Cria uma instância no Evolution API (Baileys), registra o webhook apontando
   * pra /api/webhook/evolution e persiste provider+token no config. Retorna o
   * QR base64 pra parear. Espelha create() do UazAPI mas no gateway Evolution.
   */
  async createEvolution(nome: string, user: AuthUser) {
    if (!this.evoBaseUrl) throw new BadRequestException('EVOLUTION_BASE_URL não configurado');

    const { data } = await firstValueFrom(
      this.http.post<EvoCreateResponse>(
        `${this.evoBaseUrl}/instance/create`,
        {
          instanceName: nome,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          webhook: {
            url: this.evoWebhookUrl,
            byEvents: false,
            base64: false,
            events: this.evoEvents(),
          },
        },
        { headers: this.evoHeaders() },
      ),
    );

    const evolution_token =
      typeof data.hash === 'string' ? data.hash : data.hash?.apikey;
    if (!evolution_token) {
      throw new BadGatewayException('Evolution não retornou apikey da instância (hash)');
    }
    const qrBase64 = data.qrcode?.base64 ?? null;

    // Best-effort: garante webhook setado mesmo em versões que ignoram o campo
    // webhook no create. Idempotente.
    await firstValueFrom(
      this.http.post(
        `${this.evoBaseUrl}/webhook/set/${nome}`,
        {
          webhook: {
            enabled: true,
            url: this.evoWebhookUrl,
            webhookByEvents: false,
            webhookBase64: false,
            events: this.evoEvents(),
          },
        },
        { headers: this.evoHeaders(evolution_token) },
      ),
    ).catch((err: unknown) =>
      this.logger.warn(`Falha ao setar webhook Evolution para ${nome}: ${String(err)}`),
    );

    const config = { provider: 'evolution' as const, evolution_token };
    const existing = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
    });
    if (existing) {
      await this.prisma.whatsappInstance.update({
        where: { id: existing.id },
        data: { status: 'connecting', config },
      });
    } else {
      await this.prisma.whatsappInstance.create({
        data: {
          nome,
          status: 'connecting',
          config,
          owner_user_id: user.id,
          tenant_id: user.tenantId,
        },
      });
    }

    return { instanceName: nome, status: 'connecting', base64: qrBase64 };
  }

  /** Busca/renova o QR de uma instância Evolution. */
  async getQrCodeEvolution(nome: string, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const apikey = cfg.evolution_token;
    if (!apikey) throw new NotFoundException(`Token Evolution ausente para instancia ${nome}`);
    const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;

    const { data } = await firstValueFrom(
      this.http.get<EvoConnectResponse>(`${baseUrl}/instance/connect/${nome}`, {
        headers: this.evoHeaders(apikey),
      }),
    );

    const qr = data.base64 ?? data.qrcode?.base64 ?? null;
    if (!qr) {
      // Sem QR → provavelmente já conectado.
      await this.prisma.whatsappInstance.update({
        where: { tenant_id_nome: { tenant_id: user.tenantId, nome } },
        data: { status: 'open', ultimo_check: new Date() },
      });
      return { base64: null, alreadyConnected: true };
    }
    return { base64: qr, alreadyConnected: false };
  }

  async getQrCode(nome: string, user: AuthUser) {
    // Despacha por provider: Evolution usa o fluxo próprio (connect).
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
      select: { config: true },
    });
    if ((inst?.config as InstanceConfig | null)?.provider === 'evolution') {
      return this.getQrCodeEvolution(nome, user);
    }
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
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
      select: { config: true },
    });
    const cfg = (inst?.config ?? {}) as InstanceConfig;
    if (cfg.provider === 'evolution') {
      const apikey = cfg.evolution_token;
      if (!apikey) throw new NotFoundException(`Token Evolution ausente para instancia ${nome}`);
      const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;
      const { data } = await firstValueFrom(
        this.http.get<{ instance?: { state?: string } }>(
          `${baseUrl}/instance/connectionState/${nome}`,
          { headers: this.evoHeaders(apikey) },
        ),
      );
      const stateMap: Record<string, string> = {
        open: 'open', connecting: 'connecting', close: 'close',
      };
      const status = stateMap[data.instance?.state ?? ''] ?? 'disconnected';
      await this.prisma.whatsappInstance.update({
        where: { tenant_id_nome: { tenant_id: user.tenantId, nome } },
        data: { status, ultimo_check: new Date() },
      });
      return data;
    }
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

  /**
   * Manda read-receipt (check azul + zera não-lidas no celular) pro WhatsApp via
   * Evolution. Sem isso, ler/responder no CRM não desmarca a conversa no app
   * oficial — o operador via "não lida" no celular mesmo já tendo respondido.
   *
   * Evolution v2: POST /chat/markMessageAsRead/{instance} com
   * { readMessages: [{ remoteJid, fromMe, id }] }. As msgs são as INCOMING do
   * cliente (fromMe=false), remoteJid = numero@s.whatsapp.net.
   */
  async markChatReadEvolution(
    baseUrl: string,
    apikey: string,
    instanceName: string,
    number: string,
    messageIds: string[],
  ): Promise<void> {
    if (!apikey || !number || messageIds.length === 0) return;
    const remoteJid = `${number}@s.whatsapp.net`;
    const readMessages = messageIds.map((id) => ({ remoteJid, fromMe: false, id }));
    await firstValueFrom(
      this.http.post(
        `${baseUrl}/chat/markMessageAsRead/${instanceName}`,
        { readMessages },
        { headers: this.evoHeaders(apikey), timeout: 10000 },
      ),
    ).catch((err: unknown) => {
      this.logger.warn(
        `markMessageAsRead Evolution falhou inst=${instanceName} number=${number}: ${String(err)}`,
      );
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

    if (cfg.provider === 'evolution') {
      const apikey = cfg.evolution_token;
      const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;
      if (apikey && baseUrl) {
        // Logout (encerra sessão) + delete no servidor Evolution.
        await firstValueFrom(
          this.http.delete(`${baseUrl}/instance/logout/${nome}`, { headers: this.evoHeaders(apikey) }),
        ).catch(() => null);
        await firstValueFrom(
          this.http.delete(`${baseUrl}/instance/delete/${nome}`, { headers: this.evoHeaders(apikey) }),
        ).catch((err: unknown) => {
          this.logger.warn(`Falha ao deletar instancia Evolution ${nome}: ${String(err)}`);
          return null;
        });
      }
    } else {
      const token = cfg.uazapi_token;
      if (token && !cfg.imported) {
        await firstValueFrom(
          this.http.delete(`${this.baseUrl}/instance`, {
            headers: { ...this.adminHeaders(), ...this.headers(token) },
          }),
        ).catch((err: unknown) => {
          this.logger.warn(`Falha ao deletar instancia UazAPI ${nome}: ${String(err)}`);
          return null;
        });
      }
    }

    await this.prisma.whatsappInstance.delete({ where: { id: instance.id } }).catch((err: unknown) => {
      this.logger.warn(`Falha ao deletar instancia DB ${nome}: ${String(err)}`);
      return null;
    });
    return { hidden: false };
  }
}
