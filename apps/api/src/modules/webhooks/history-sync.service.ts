import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  backfillJobPayload,
  chatHasGap,
  messageTs,
  parseChatsPage,
  parseFindMessages,
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    @InjectQueue('webhooks') private readonly webhookQueue: Queue,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
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
      select: { id: true, nome: true, config: true },
    });
    const summaries: SyncSummary[] = [];
    for (const inst of instances) {
      if (!this.tokenOf(inst.config)) continue; // Evolution ou sem credencial
      summaries.push(await this.syncInstance(inst.id, windowMs));
    }
    return summaries;
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
        await this.webhookQueue.add('uazapi.messages', backfillJobPayload(m, token), {
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
