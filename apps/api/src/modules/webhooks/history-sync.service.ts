import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import {
  backfillJobPayload,
  chatHasGap,
  evolutionBackfillJobPayload,
  messageTs,
  parseChatsPage,
  parseEvolutionChats,
  parseEvolutionMessages,
  parseFindMessages,
  type EvoSyncChat,
  type SyncChat,
} from './history-sync';

export interface SyncSummary {
  chats_scanned: number;
  chats_synced: number;
  messages_enqueued: number;
}

const ZERO: SyncSummary = { chats_scanned: 0, chats_synced: 0, messages_enqueued: 0 };

/**
 * Espelho WhatsApp Web para instâncias UazAPI: o servidor uazapiGO guarda o
 * histórico de chats/mensagens, então webhook perdido NÃO é mensagem perdida —
 * este serviço compara o último timestamp de cada chat (POST /chat/find) com o
 * banco e re-injeta o que falta (POST /message/find) na fila `webhooks` como
 * jobs `uazapi.messages` com flag backfill (timestamp original, sem
 * notificação — ver SaveMessageInput.backfill). Dedupe em duas camadas: jobId
 * determinístico na fila + upsert UNIQUE (tenant_id, whatsapp_message_id).
 *
 * Gatilhos: cron 30min (janela 48h, pega queda silenciosa de webhook),
 * reconexão close→open (janela 7d, disparado pelo UazapiEventsHandler) e
 * manual via endpoints (até 60d). Evolution fica fora — acks e webhooks dela
 * funcionam; estrutura é provider-scoped pra estender depois.
 * Spec: docs/superpowers/specs/2026-08-20-history-sync-design.md.
 */
@Injectable()
export class HistorySyncService {
  private readonly logger = new Logger(HistorySyncService.name);
  private readonly baseUrl: string;
  /** Instâncias com sync em curso — reentrância vira no-op. */
  private readonly syncing = new Set<string>();
  private cronRunning = false;

  static readonly CRON_WINDOW_MS = 48 * 3_600_000;
  static readonly RECONNECT_WINDOW_MS = 7 * 24 * 3_600_000;
  private static readonly PAGE_SIZE = 100;
  private static readonly MAX_CHATS_PER_RUN = 400;
  private static readonly MAX_MSGS_PER_CHAT = 500;
  private static readonly HTTP_TIMEOUT_MS = 12_000;

  private readonly evoBaseUrl: string;
  private readonly evoApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    @InjectQueue('webhooks') private readonly webhookQueue: Queue,
    private readonly gateway: CrmGateway,
    private readonly cache: RedisCacheService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.evoBaseUrl = this.config.get<string>('EVOLUTION_BASE_URL', '');
    this.evoApiKey = this.config.get<string>('EVOLUTION_API_KEY', '');
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    if (this.cronRunning) return;
    this.cronRunning = true;
    try {
      await this.syncAllUazapi(HistorySyncService.CRON_WINDOW_MS);
    } catch (err) {
      this.logger.error(`varredura de history sync falhou: ${(err as Error).message}`);
    } finally {
      this.cronRunning = false;
    }
  }

  async syncAllUazapi(windowMs: number): Promise<SyncSummary[]> {
    const instances = await this.prisma.whatsappInstance.findMany({
      where: { status: 'open' },
      select: { id: true, nome: true, tenant_id: true, config: true },
    });
    const summaries: SyncSummary[] = [];
    for (const inst of instances) {
      if (!this.tokenOf(inst.config)) continue; // Evolution ou sem credencial
      summaries.push(await this.syncInstance(inst.id, windowMs));
    }
    // Evolution: mesmo espelho. O gateway guarda TODAS as mensagens no
    // Postgres dele (independente do webhook ter chegado ao CRM), então
    // buraco também é recuperável — findChats acha o gap, findMessages
    // re-injeta. Badges vão na mesma passada (Baileys espelha a sessão real:
    // unreadCount cai quando a pessoa lê no celular/WhatsApp Web — sinal que
    // o webhook chats.update da Evolution NÃO carrega).
    for (const inst of instances) {
      const cfg = (inst.config ?? {}) as Record<string, unknown>;
      if (cfg.provider !== 'evolution') continue;
      try {
        summaries.push(await this.syncEvolutionInstance(inst.id, windowMs));
      } catch (err) {
        this.logger.warn(
          `history sync evolution (${inst.nome}) falhou: ${(err as Error).message}`,
        );
      }
    }
    return summaries;
  }

  /** Espelho WhatsApp Web para uma instância Evolution. */
  async syncEvolutionInstance(instanceId: string, windowMs: number): Promise<SyncSummary> {
    if (this.syncing.has(instanceId)) return { ...ZERO };
    this.syncing.add(instanceId);
    try {
      return await this.runEvolution(instanceId, windowMs);
    } finally {
      this.syncing.delete(instanceId);
    }
  }

  private async runEvolution(instanceId: string, windowMs: number): Promise<SyncSummary> {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { id: instanceId } });
    if (!instance || !this.evoBaseUrl || !this.evoApiKey) return { ...ZERO };

    const since = Date.now() - windowMs;
    const summary: SyncSummary = { ...ZERO };

    const res = await firstValueFrom(
      this.http.post(
        `${this.evoBaseUrl}/chat/findChats/${instance.nome}`,
        {},
        { headers: { apikey: this.evoApiKey }, timeout: 30_000 },
      ),
    );
    const chats = parseEvolutionChats(res.data);

    for (const chat of chats) {
      if (chat.lastMsgTs < since) continue;
      if (summary.chats_scanned >= HistorySyncService.MAX_CHATS_PER_RUN) break;
      summary.chats_scanned++;
      try {
        const enqueued = await this.syncEvolutionChat(
          instance.tenant_id,
          instance.id,
          instance.nome,
          chat,
          since,
        );
        if (enqueued > 0) {
          summary.chats_synced++;
          summary.messages_enqueued += enqueued;
        }
      } catch (err) {
        this.logger.warn(
          `sync do chat ${chat.phone} (evolution ${instance.nome}) falhou: ${(err as Error).message}`,
        );
      }
    }

    // Badges de QUALQUER idade na mesma passada: o findChats já trouxe TODOS
    // os chats (não só a janela). unreadCount=0 do Baileys = lido no
    // aparelho/WhatsApp Web. Só zera, nunca sobe.
    const unreadByPhone = new Map<string, number>();
    for (const c of chats) {
      if (c.unreadCount === null) continue;
      const prev = unreadByPhone.get(c.phone);
      unreadByPhone.set(c.phone, prev === undefined ? c.unreadCount : Math.min(prev, c.unreadCount));
    }
    const unreadLeads = await this.prisma.lead.findMany({
      where: {
        tenant_id: instance.tenant_id,
        instancia_whatsapp: instance.nome,
        mensagens_nao_lidas: { gt: 0 },
      },
      orderBy: { ultima_interacao: 'desc' },
      take: HistorySyncService.MAX_BADGE_CHECKS,
      select: { id: true, telefone: true },
    });
    for (const lead of unreadLeads) {
      if (unreadByPhone.get(lead.telefone) === 0) {
        await this.zeroLeadUnread(instance.tenant_id, lead.id, lead.telefone);
      }
    }

    if (summary.messages_enqueued > 0 || summary.chats_scanned > 0) {
      this.logger.log(
        `history sync evolution ${instance.nome}: ${summary.chats_scanned} chats na janela, ` +
          `${summary.chats_synced} com buraco, ${summary.messages_enqueued} msgs re-injetadas`,
      );
    }
    return summary;
  }

  private async syncEvolutionChat(
    tenantId: string,
    instanceId: string,
    instanceNome: string,
    chat: EvoSyncChat,
    sinceMs: number,
  ): Promise<number> {
    // Prova exata primeiro (vem de graça no findChats): última msg do chat já
    // está no banco → em dia, nem consulta o findMessages.
    if (chat.newestId) {
      const existing = await this.prisma.message.findUnique({
        where: {
          tenant_id_whatsapp_message_id: {
            tenant_id: tenantId,
            whatsapp_message_id: chat.newestId,
          },
        },
        select: { id: true },
      });
      if (existing) return 0;
    }
    const last = await this.prisma.message.findFirst({
      where: { tenant_id: tenantId, lead: { telefone: chat.phone, tenant_id: tenantId } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    if (
      !chatHasGap(
        {
          chatid: chat.queryJid,
          phone: chat.phone,
          name: chat.name,
          contactName: null,
          lidJid: null,
          lastMsgTs: chat.lastMsgTs,
          unreadCount: chat.unreadCount,
        },
        last ? last.created_at.getTime() : null,
        sinceMs,
      )
    ) {
      return 0;
    }

    let enqueued = 0;
    let page = 1;
    for (;;) {
      const res = await firstValueFrom(
        this.http.post(
          `${this.evoBaseUrl}/chat/findMessages/${instanceNome}`,
          {
            where: { key: { remoteJid: chat.queryJid } },
            limit: HistorySyncService.PAGE_SIZE,
            page,
          },
          { headers: { apikey: this.evoApiKey }, timeout: 20_000 },
        ),
      );
      const { records, hasMore } = parseEvolutionMessages(res.data);
      if (records.length === 0) break;

      let sawOutOfWindow = false;
      for (const rec of records) {
        const ts = messageTs(rec);
        if (ts < sinceMs) {
          sawOutOfWindow = true; // ordem DESC — daqui pra frente é mais velho
          continue;
        }
        const key = (rec.key ?? {}) as Record<string, unknown>;
        const messageid = typeof key.id === 'string' && key.id ? key.id : null;
        if (!messageid) continue;
        await this.webhookQueue.add(
          'messages.upsert',
          evolutionBackfillJobPayload(rec, instanceNome, chat.phone),
          {
            jobId: `bf-${instanceId}-${messageid}`.replace(/[^A-Za-z0-9_-]/g, '_'),
            attempts: 3,
          },
        );
        enqueued++;
        if (enqueued >= HistorySyncService.MAX_MSGS_PER_CHAT) return enqueued;
      }

      if (sawOutOfWindow || !hasMore) break;
      page++;
    }
    return enqueued;
  }

  async syncInstance(instanceId: string, windowMs: number): Promise<SyncSummary> {
    if (this.syncing.has(instanceId)) return { ...ZERO };
    this.syncing.add(instanceId);
    try {
      return await this.run(instanceId, windowMs);
    } finally {
      this.syncing.delete(instanceId);
    }
  }

  private tokenOf(config: unknown): string | null {
    const cfg = (config ?? {}) as Record<string, unknown>;
    return typeof cfg.uazapi_token === 'string' && cfg.uazapi_token ? cfg.uazapi_token : null;
  }

  private async run(instanceId: string, windowMs: number): Promise<SyncSummary> {
    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { id: instanceId },
    });
    const token = instance ? this.tokenOf(instance.config) : null;
    if (!instance || !token) return { ...ZERO };

    const since = Date.now() - windowMs;
    const summary: SyncSummary = { ...ZERO };

    let offset = 0;
    paging: for (;;) {
      let raw: unknown;
      try {
        const res = await firstValueFrom(
          this.http.post(
            `${this.baseUrl}/chat/find`,
            {
              limit: HistorySyncService.PAGE_SIZE,
              offset,
              sort: '-wa_lastMsgTimestamp',
            },
            { headers: { token }, timeout: HistorySyncService.HTTP_TIMEOUT_MS },
          ),
        );
        raw = res.data;
      } catch (err) {
        this.logger.warn(
          `chat/find falhou (${instance.nome}, offset=${offset}): ${(err as Error).message}`,
        );
        break;
      }

      const pageLen = (((raw as Record<string, unknown> | undefined)?.chats as unknown[]) ?? [])
        .length;
      const chats = parseChatsPage(raw);
      // Ordenado por -wa_lastMsgTimestamp: página inteira fora da janela =
      // todas as próximas também estão. (Só checa quando a página tem chats
      // individuais; página só de grupos segue adiante.)
      if (chats.length > 0 && chats.every((c) => c.lastMsgTs < since)) break;

      for (const chat of chats) {
        if (chat.lastMsgTs < since) continue;
        if (summary.chats_scanned >= HistorySyncService.MAX_CHATS_PER_RUN) break paging;
        summary.chats_scanned++;
        try {
          const enqueued = await this.syncChat(instance.tenant_id, instance.id, token, chat, since);
          if (enqueued > 0) {
            summary.chats_synced++;
            summary.messages_enqueued += enqueued;
          }
          await this.refreshLeadContact(instance.tenant_id, chat);
          await this.reconcileUnread(instance.tenant_id, chat);
        } catch (err) {
          // warn, não debug: LOG_LEVEL de produção esconde debug e um chat
          // que sempre falha ficaria invisível pra sempre.
          this.logger.warn(
            `sync do chat ${chat.phone} (${instance.nome}) falhou: ${(err as Error).message}`,
          );
        }
      }

      if (pageLen < HistorySyncService.PAGE_SIZE) break;
      offset += pageLen;
    }

    // Badges presas de QUALQUER idade: a varredura acima só visita chats com
    // atividade dentro da janela — um chat lido no celular semanas atrás
    // ficaria com o badge do CRM preso pra sempre. Direção inversa: pega os
    // leads que o CRM acha não-lidos (conjunto pequeno) e pergunta ao
    // servidor o estado real de cada um.
    await this.reconcileStuckBadges(instance.tenant_id, instance.nome, token);

    if (summary.messages_enqueued > 0 || summary.chats_scanned > 0) {
      this.logger.log(
        `history sync ${instance.nome}: ${summary.chats_scanned} chats na janela, ` +
          `${summary.chats_synced} com buraco, ${summary.messages_enqueued} msgs re-injetadas`,
      );
    }
    return summary;
  }

  /** Re-injeta as mensagens faltantes de um chat. Retorna quantas enfileirou. */
  private async syncChat(
    tenantId: string,
    instanceId: string,
    token: string,
    chat: SyncChat,
    sinceMs: number,
  ): Promise<number> {
    const last = await this.prisma.message.findFirst({
      where: { tenant_id: tenantId, lead: { telefone: chat.phone, tenant_id: tenantId } },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    if (!chatHasGap(chat, last ? last.created_at.getTime() : null, sinceMs)) return 0;

    let enqueued = 0;
    let offset = 0;
    let newestChecked = false;
    for (;;) {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/message/find`,
          { chatid: chat.chatid, limit: HistorySyncService.PAGE_SIZE, offset },
          { headers: { token }, timeout: HistorySyncService.HTTP_TIMEOUT_MS },
        ),
      );
      const page = parseFindMessages(res.data);
      if (page.messages.length === 0) break;

      // O timestamp do chat não prova buraco: OUTGOING do CRM nasce no banco
      // ao ENFILEIRAR e o WhatsApp carimba até minutos depois (disparo com
      // throttle) — margem de relógio nunca cobre todos os casos. Prova
      // exata: se a mensagem MAIS NOVA do servidor já está no banco pelo
      // whatsapp_message_id, o chat está em dia — sai sem re-injetar.
      if (!newestChecked) {
        newestChecked = true;
        const newest = page.messages.find(
          (m) => m.isGroup !== true && (typeof m.messageid === 'string' && m.messageid),
        );
        const newestId = newest ? (newest.messageid as string) : null;
        if (newestId) {
          const existing = await this.prisma.message.findUnique({
            where: {
              tenant_id_whatsapp_message_id: {
                tenant_id: tenantId,
                whatsapp_message_id: newestId,
              },
            },
            select: { id: true },
          });
          if (existing) return 0;
        }
      }

      let sawOutOfWindow = false;
      for (const m of page.messages) {
        const ts = messageTs(m);
        if (ts < sinceMs) {
          // Vem em ordem DESC — daqui pra frente é tudo mais velho.
          sawOutOfWindow = true;
          continue;
        }
        if (m.isGroup === true) continue;
        const messageid =
          (typeof m.messageid === 'string' && m.messageid) ||
          (typeof m.id === 'string' && m.id) ||
          null;
        if (!messageid) continue; // sem id não há dedupe seguro
        await this.webhookQueue.add('uazapi.messages', backfillJobPayload(m, token, chat.phone), {
          jobId: `bf-${instanceId}-${messageid}`.replace(/[^A-Za-z0-9_-]/g, '_'),
          attempts: 3,
        });
        enqueued++;
        if (enqueued >= HistorySyncService.MAX_MSGS_PER_CHAT) return enqueued;
      }

      if (sawOutOfWindow || !page.hasMore) break;
      offset = page.nextOffset > offset ? page.nextOffset : offset + page.messages.length;
    }
    return enqueued;
  }

  /**
   * Badge espelha o APARELHO: wa_unreadCount=0 no servidor significa que a
   * pessoa já leu (ou respondeu) no celular — o CRM não pode continuar
   * mostrando não-lidas. Só zera, nunca sobe: badge >0 no servidor com CRM
   * zerado é leitura feita DENTRO do CRM, que o celular não conhece.
   * É o caminho que conserta o badge preso: o ReadReceipt deste uazapiGO vem
   * sem message id e o ack de leitura nunca casa (ver status-reconciler).
   */
  private async reconcileUnread(tenantId: string, chat: SyncChat): Promise<void> {
    if (chat.unreadCount !== 0) return;
    const lead = await this.prisma.lead.findFirst({
      where: { tenant_id: tenantId, telefone: chat.phone, mensagens_nao_lidas: { gt: 0 } },
      select: { id: true },
    });
    if (!lead) return;
    await this.zeroLeadUnread(tenantId, lead.id, chat.phone);
  }

  private async zeroLeadUnread(tenantId: string, leadId: string, phone: string): Promise<void> {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { mensagens_nao_lidas: 0 },
    });
    await this.prisma.message.updateMany({
      where: { lead_id: leadId, direction: 'INCOMING', status: { not: 'READ' } },
      data: { status: 'READ' },
    });
    await this.cache.delPattern(`leads:list:${tenantId}:*`);
    this.gateway.emitLeadUnreadReset(leadId, tenantId);
    this.logger.log(`badge zerado via aparelho: lead ${leadId} (${phone})`);
  }

  /** Máx. de leads não-lidos consultados no servidor por varredura. */
  private static readonly MAX_BADGE_CHECKS = 150;

  /**
   * Zera badges presas de QUALQUER idade. Consulta o servidor lead a lead
   * (filtro exato `wa_chatid`, verificado em produção) só para os que o CRM
   * marca como não-lidos nesta instância — dezenas, não milhares. Só zera
   * quando o servidor afirma wa_unreadCount=0; chat não encontrado = sem
   * prova, não mexe.
   */
  private async reconcileStuckBadges(
    tenantId: string,
    instanceNome: string,
    token: string,
  ): Promise<void> {
    const unreadLeads = await this.prisma.lead.findMany({
      where: {
        tenant_id: tenantId,
        instancia_whatsapp: instanceNome,
        mensagens_nao_lidas: { gt: 0 },
      },
      orderBy: { ultima_interacao: 'desc' },
      take: HistorySyncService.MAX_BADGE_CHECKS,
      select: { id: true, telefone: true },
    });
    for (const lead of unreadLeads) {
      try {
        const res = await firstValueFrom(
          this.http.post(
            `${this.baseUrl}/chat/find`,
            { operator: 'AND', wa_chatid: `${lead.telefone}@s.whatsapp.net`, limit: 1 },
            { headers: { token }, timeout: HistorySyncService.HTTP_TIMEOUT_MS },
          ),
        );
        const chat = parseChatsPage(res.data)[0];
        if (chat && chat.unreadCount === 0) {
          await this.zeroLeadUnread(tenantId, lead.id, lead.telefone);
        }
      } catch (err) {
        this.logger.warn(
          `badge check falhou (${instanceNome}/${lead.telefone}): ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Contato correto mesmo sem mensagem nova, espelhando o WhatsApp Web:
   * - nome da AGENDA (wa_contactName) vale mais que o pushName do perfil do
   *   cliente — a operadora salvou "Fernanda Greick" no celular e precisa
   *   achar por esse nome, não pelo nome de perfil do contato;
   * - sem nome de agenda, o melhor nome do chat só substitui placeholder
   *   (lead com o próprio telefone como nome);
   * - @lid entra quando faltava (envio LID-safe).
   */
  private async refreshLeadContact(tenantId: string, chat: SyncChat): Promise<void> {
    if (chat.contactName) {
      await this.prisma.lead.updateMany({
        where: { tenant_id: tenantId, telefone: chat.phone, nome: { not: chat.contactName } },
        data: { nome: chat.contactName },
      });
    } else if (chat.name) {
      await this.prisma.lead.updateMany({
        where: { tenant_id: tenantId, telefone: chat.phone, nome: chat.phone },
        data: { nome: chat.name },
      });
    }
    if (chat.lidJid) {
      await this.prisma.lead.updateMany({
        where: { tenant_id: tenantId, telefone: chat.phone, whatsapp_lid: null },
        data: { whatsapp_lid: chat.lidJid },
      });
    }
  }
}
