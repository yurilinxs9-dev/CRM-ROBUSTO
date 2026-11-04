import { Injectable, Logger, NotFoundException, BadRequestException, BadGatewayException, OnModuleInit, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import type { AuthUser } from '../../common/types/auth-user';
import { UserRole } from '../../common/types/roles';
import { isPlSalesOnly } from '../../common/access/pl-sales-access';
import { hashTruncated } from '../../common/utils/hash-truncated';
import { HistorySyncService } from '../webhooks/history-sync.service';
import { KanbanIndividualService } from '../pipelines/kanban-individual.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { isManagerRole } from '../leads/lead-visibility';
import { DIRECT_TO_OWNER_KEY } from './direct-to-owner';
import type { Prisma } from '@prisma/client';

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
    private historySync: HistorySyncService,
    @Optional() private kanbanIndividual?: KanbanIndividualService,
    @Optional() private cache?: RedisCacheService,
    @Optional() private gateway?: CrmGateway,
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

    const evoTargets = instances
      .map((i) => {
        const cfg = (i.config ?? {}) as InstanceConfig;
        if (cfg.provider !== 'evolution' || !cfg.evolution_token) return null;
        return {
          nome: i.nome,
          apikey: cfg.evolution_token,
          baseUrl: cfg.evolution_base_url || this.evoBaseUrl,
        };
      })
      .filter((x): x is { nome: string; apikey: string; baseUrl: string } => !!x);

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

    // Evolution: só 1 webhook por instância no gateway — se outro sistema
    // registrar a URL dele (aconteceu com o app do questionário em 24/08/2026),
    // o CRM para de receber TUDO silenciosamente, inclusive connection.update,
    // e o status vira mentira. Aqui a gente re-aponta pra evoWebhookUrl e
    // garante o set completo de eventos.
    const expectedEvoEvents = [...this.evoEvents()].sort();
    const evoQueue = [...evoTargets];
    const evoWorker = async (): Promise<void> => {
      while (evoQueue.length) {
        const t = evoQueue.shift();
        if (!t) break;
        checked++;
        let needsSet = false;
        try {
          const { data } = await firstValueFrom(
            this.http.get<{ url?: string; enabled?: boolean; events?: string[] }>(
              `${t.baseUrl}/webhook/find/${t.nome}`,
              { headers: this.evoHeaders(t.apikey), timeout: 8000 },
            ),
          );
          const sameEvents =
            Array.isArray(data?.events) &&
            JSON.stringify([...data.events].sort()) === JSON.stringify(expectedEvoEvents);
          needsSet = data?.url !== this.evoWebhookUrl || data?.enabled !== true || !sameEvents;
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status === 404) {
            // Nenhum webhook registrado — precisa setar.
            needsSet = true;
          } else {
            // 401 = apikey revogada (instância deletada no gateway). Skip.
            skipped++;
            const msg = status === 401 ? '401 apikey revogada' : String((err as Error)?.message ?? err);
            this.logger.debug(`webhook re-sync evolution ${t.nome} skip: ${msg}`);
            continue;
          }
        }
        if (!needsSet) {
          skipped++;
          continue;
        }
        try {
          await firstValueFrom(
            this.http.post(
              `${t.baseUrl}/webhook/set/${t.nome}`,
              {
                webhook: {
                  enabled: true,
                  url: this.evoWebhookUrl,
                  webhookByEvents: false,
                  webhookBase64: false,
                  events: this.evoEvents(),
                },
              },
              { headers: this.evoHeaders(t.apikey), timeout: 8000 },
            ),
          );
          updated++;
          this.logger.log({
            event: 'instances.healWebhooks.evolution_url_updated',
            instance_name_hash: hashTruncated(t.nome),
          });
        } catch (err: unknown) {
          skipped++;
          this.logger.debug(
            `webhook re-sync evolution ${t.nome} set falhou: ${String((err as Error)?.message ?? err)}`,
          );
        }
      }
    };

    await Promise.all([
      worker(), worker(), worker(), worker(), worker(),
      evoWorker(), evoWorker(), evoWorker(),
    ]);
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
      select: { pool_enabled: true, manager_full_access: true },
    });
    const hiddenIds = (
      await this.prisma.instanceHidden.findMany({
        where: { user_id: user.id, tenant_id: user.tenantId },
        select: { instance_id: true },
      })
    ).map((h) => h.instance_id);

    // Modo Compartilhado: todos veem o mesmo número (a instância é da equipe,
    // não pessoal). Modo Individual: cada user vê apenas as próprias — exceto o
    // gestor com acesso total (Ferbraço), que administra o número de cada
    // vendedor e escolhe quem responde por ele (setOwner).
    const seesAll =
      (tenant?.pool_enabled || (tenant?.manager_full_access && isManagerRole(user.role as UserRole))) &&
      !isPlSalesOnly(user);
    const ownerFilter = seesAll ? {} : { owner_user_id: user.id };

    const where = {
      tenant_id: user.tenantId,
      ...ownerFilter,
      ...(hiddenIds.length ? { id: { notIn: hiddenIds } } : {}),
    };
    if (isPlSalesOnly(user)) {
      return this.prisma.whatsappInstance.findMany({
        where,
        orderBy: { created_at: 'asc' },
        select: { id: true, nome: true, telefone: true, status: true, ultimo_check: true },
      });
    }
    return this.prisma.whatsappInstance.findMany({
      where,
      orderBy: { created_at: 'asc' },
      include: { owner: { select: { id: true, nome: true } } },
    });
  }

  /**
   * F-02: define o setor que atende o número (destino do round-robin). null
   * volta a cair no setor padrão "Sem Setor". Valida que ambos são do tenant.
   */
  /**
   * Dispara em background o re-sync de histórico da instância (espelho
   * WhatsApp Web). Retorno imediato; progresso vai pro log. Com `deep` o sync
   * ignora a prova de "chat em dia" e varre a janela inteira de cada chat —
   * único jeito de recuperar mensagem perdida no MIOLO da conversa.
   */
  async startHistorySync(nome: string, days: number, deep: boolean, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
      select: { id: true, config: true },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as Record<string, unknown>;
    const isEvolution = cfg.provider === 'evolution';
    const hasUazapiToken = typeof cfg.uazapi_token === 'string' && !!cfg.uazapi_token;
    if (!isEvolution && !hasUazapiToken) {
      throw new BadRequestException('Instancia sem provider suportado para history sync');
    }
    const windowMs = days * 24 * 3_600_000;
    const run = isEvolution
      ? this.historySync.syncEvolutionInstance(instance.id, windowMs, deep)
      : this.historySync.syncInstance(instance.id, windowMs, deep);
    void run.catch((err) => this.logger.warn(`history sync manual (${nome}): ${String(err)}`));
    return { started: true, days, deep };
  }

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

  /**
   * Define o vendedor responsável pelo número e liga a marca `direct_to_owner`:
   * lead que chega nele vai direto para o dono em QUALQUER modo do tenant (no
   * Compartilhado, número de vendedor caía no pool — ver inbound-message). O
   * `owner_user_id` também dá ao vendedor acesso às conversas do número. Antes
   * só valia quem conectou: o gestor que conectava o WhatsApp de cada vendedor
   * ficava dono de todos.
   *
   * Aceita o MESMO dono: é como o gestor liga a regra num número que o
   * vendedor já conectou e puxa para ele os leads parados no pool.
   *
   * `transferLeads`: leva junto os leads DESTE número que estão sem dono ou com
   * o dono anterior (e as conversas/mensagens privadas deles), remapeando a
   * coluna para o board do novo dono. Lead que outro vendedor assumiu fica.
   */
  async setOwner(instanceId: string, ownerUserId: string, transferLeads: boolean, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { id: instanceId, tenant_id: user.tenantId },
      select: { id: true, nome: true, owner_user_id: true, config: true },
    });
    if (!instance) throw new NotFoundException('Instância não encontrada');
    const novo = await this.prisma.user.findFirst({
      where: { id: ownerUserId, tenant_id: user.tenantId, ativo: true },
      select: { id: true, nome: true, role: true },
    });
    if (!novo) throw new BadRequestException('Usuário inválido ou inativo');
    if (novo.role === UserRole.VISUALIZADOR) {
      throw new BadRequestException('Visualizador não atende conversas — escolha um operador ou gerente.');
    }
    const anteriorId = instance.owner_user_id;
    const trocouDono = anteriorId !== novo.id;

    const tenantId = user.tenantId;
    // Sem dono (pool/nuvem) ou com o dono anterior; nunca o que outro assumiu.
    const donosQueSaem = [{ responsavel_id: null }, ...(trocouDono ? [{ responsavel_id: anteriorId }] : [])];
    const leadsDoNumero = { tenant_id: tenantId, instancia_whatsapp: instance.nome, OR: donosQueSaem };
    const leads = transferLeads
      ? await this.prisma.lead.findMany({
          where: leadsDoNumero,
          select: { id: true, estagio_id: true, pipeline_id: true, responsavel_id: true },
        })
      : [];
    const configAtual =
      instance.config && typeof instance.config === 'object' && !Array.isArray(instance.config)
        ? (instance.config as Prisma.JsonObject)
        : {};
    // Coluna equivalente no board do novo dono (identidade sem kanban individual).
    // Fora da transação: a tradução lê e pode criar o board PL do vendedor.
    const destinoPorEtapa = new Map<string, string>();
    for (const etapa of new Set(leads.map((l) => l.estagio_id))) {
      destinoPorEtapa.set(
        etapa,
        this.kanbanIndividual ? await this.kanbanIndividual.stageForOwner(tenantId, novo.id, etapa) : etapa,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.whatsappInstance.update({
        where: { id: instance.id },
        data: { owner_user_id: novo.id, config: { ...configAtual, [DIRECT_TO_OWNER_KEY]: true } },
      });
      if (leads.length === 0) return;
      for (const [etapa, destino] of destinoPorEtapa) {
        await tx.lead.updateMany({
          where: { ...leadsDoNumero, estagio_id: etapa },
          data: {
            responsavel_id: novo.id,
            // Ganhou dono: sai da nuvem de devolvidos (mesma regra do inbound).
            returned_at: null,
            ...(destino !== etapa ? { estagio_id: destino, estagio_entered_at: new Date() } : {}),
          },
        });
      }
      // Sem a conversa, a próxima mensagem do cliente devolveria o lead ao
      // dono anterior (ou ao pool); sem as mensagens privadas, o vendedor
      // abriria o chat do próprio número sem o histórico.
      await tx.conversation.updateMany({
        where: { tenant_id: tenantId, instancia_whatsapp: instance.nome, OR: donosQueSaem },
        data: { responsavel_id: novo.id },
      });
      if (trocouDono) {
        await tx.message.updateMany({
          where: { tenant_id: tenantId, instance_name: instance.nome, visible_to_user_id: anteriorId },
          data: { visible_to_user_id: novo.id },
        });
      }
      await tx.leadActivity.createMany({
        data: leads.map((l) => ({
          lead_id: l.id,
          user_id: user.id,
          tipo: 'REASSIGNED' as const,
          descricao: `Lead direcionado para ${novo.nome}, responsável pelo número ${instance.nome}`,
          dados_antes: { responsavel_id: l.responsavel_id },
          dados_depois: { responsavel_id: novo.id },
          tenant_id: tenantId,
        })),
      });
    }, { timeout: 60_000, maxWait: 10_000 });

    if (leads.length > 0) {
      await this.cache?.delPattern(`leads:list:${tenantId}:*`);
      for (const pipelineId of new Set(leads.map((l) => l.pipeline_id))) {
        this.gateway?.emitPipelineStagesChanged(tenantId, pipelineId, novo.id);
      }
    }
    this.logger.log(
      `instância ${instance.nome}: responsável ${anteriorId} → ${novo.id} por ${user.email} (leads transferidos: ${leads.length})`,
    );
    return { ok: true, owner_user_id: novo.id, leads_transferidos: leads.length };
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
   * Versão Evolution do fetchProfile (nome + foto). Sem isso, leads de
   * instâncias Evolution ficavam sem foto e, quando não havia pushName, sem
   * nome — o syncProfile antigo só sabia falar UazAPI.
   *  - foto: POST /chat/fetchProfilePictureUrl/{inst} { number } → profilePictureUrl
   *  - nome: POST /chat/findContacts/{inst} { where: { id: jid } } → pushName
   */
  async fetchProfileEvolution(
    baseUrl: string,
    apikey: string,
    instanceName: string,
    number: string,
  ): Promise<{ name?: string; imageUrl?: string }> {
    if (!apikey || !number) return {};
    const jid = `${number}@s.whatsapp.net`;
    const headers = this.evoHeaders(apikey);
    let imageUrl: string | undefined;
    let name: string | undefined;

    try {
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${baseUrl}/chat/fetchProfilePictureUrl/${instanceName}`,
          { number },
          { headers, timeout: 15000 },
        ),
      );
      const url = (data?.profilePictureUrl as string | undefined) ?? (data?.url as string | undefined);
      if (url && url.trim()) imageUrl = url.trim();
    } catch (err) {
      this.logger.warn(`fetchProfilePictureUrl Evolution falhou ${number}: ${String(err)}`);
    }

    try {
      const { data } = await firstValueFrom(
        this.http.post<Array<Record<string, unknown>>>(
          `${baseUrl}/chat/findContacts/${instanceName}`,
          { where: { id: jid } },
          { headers, timeout: 15000 },
        ),
      );
      const c = Array.isArray(data) ? data[0] : undefined;
      const n =
        (c?.pushName as string | undefined) ??
        (c?.name as string | undefined) ??
        (c?.verifiedName as string | undefined);
      if (n && n.trim()) name = n.trim();
    } catch (err) {
      this.logger.warn(`findContacts Evolution falhou ${number}: ${String(err)}`);
    }

    return { name, imageUrl };
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
