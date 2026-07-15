import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { MessagesService } from './messages.service';
import { DbOutbound, parseServerMessages, planReconciliation } from './status-reconciler';

/**
 * Reconciliação de status de entrega para instâncias UazAPI.
 *
 * Este servidor uazapiGO emite o webhook `messages_update` como ReadReceipt
 * SEM message id (verificado: 21k+ eventos, nenhum com id), então
 * handleUazapiMessageAck nunca casa nada e TODO outbound fica SENT eterno.
 * O status real existe em POST /message/find — este cron busca e reconcilia:
 *
 *   - Delivered/Read/Played → atualiza status + WebSocket (✓✓ no chat).
 *   - Preso em 'Sent' com mensagem posterior já entregue no mesmo chat (bug de
 *     sessão do uazapiGO no 1º contato com lead novo) → marca FAILED com
 *     send_error='stuck_sent', move o wamid pra metadata.stuck_wamid e limpa a
 *     coluna (senão resend() aborta em alreadySent) → habilita o botão
 *     Reenviar; texto ainda recente é reenviado automaticamente 1x.
 *
 * Evolution fica de fora: os acks messages.update dela funcionam.
 */
@Injectable()
export class StatusReconcilerService {
  private readonly logger = new Logger(StatusReconcilerService.name);
  private readonly baseUrl: string;
  private running = false;

  /** Janela de mensagens reconciliáveis. */
  private static readonly WINDOW_MS = 24 * 3600_000;
  /** Idade mínima pra considerar 'Sent' como preso. */
  private static readonly STUCK_AFTER_MS = 30 * 60_000;
  /** Máx. de chats consultados na UazAPI por varredura. */
  private static readonly MAX_CHATS = 60;
  /** Consultas concorrentes à UazAPI. */
  private static readonly CONCURRENCY = 4;
  /** Auto-reenvio de presas: só texto, recente e no máx. 2 tentativas. */
  private static readonly AUTO_RESEND_MAX_AGE_MS = 6 * 3600_000;
  private static readonly AUTO_RESEND_MAX_COUNT = 2;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly gateway: CrmGateway,
    private readonly cache: RedisCacheService,
    private readonly messages: MessagesService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (err) {
      this.logger.error(`reconciliação falhou: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<void> {
    const since = new Date(Date.now() - StatusReconcilerService.WINDOW_MS);
    const candidates = await this.prisma.message.findMany({
      where: {
        direction: 'OUTGOING',
        status: 'SENT',
        is_internal_note: false,
        whatsapp_message_id: { not: null },
        created_at: { gt: since },
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        whatsapp_message_id: true,
        created_at: true,
        lead_id: true,
        tenant_id: true,
        type: true,
        metadata: true,
        lead: { select: { telefone: true, instancia_whatsapp: true } },
      },
    });
    if (candidates.length === 0) return;

    // Agrupa por chat (tenant + telefone); a instância vem do lead.
    type Candidate = (typeof candidates)[number];
    const chats = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!c.lead?.telefone || !c.lead.instancia_whatsapp) continue;
      const key = `${c.tenant_id}|${c.lead.instancia_whatsapp}|${c.lead.telefone}`;
      const arr = chats.get(key);
      if (arr) arr.push(c);
      else chats.set(key, [c]);
    }

    // Resolve token UazAPI por (tenant, instância); pula Evolution.
    const instances = await this.prisma.whatsappInstance.findMany({
      select: { tenant_id: true, nome: true, config: true },
    });
    const tokenByKey = new Map<string, string>();
    for (const i of instances) {
      const cfg = (i.config ?? {}) as Record<string, unknown>;
      if (cfg.provider === 'evolution') continue;
      if (typeof cfg.uazapi_token === 'string' && cfg.uazapi_token) {
        tokenByKey.set(`${i.tenant_id}|${i.nome}`, cfg.uazapi_token);
      }
    }

    const queue = [...chats.entries()].slice(0, StatusReconcilerService.MAX_CHATS);
    let updated = 0;
    let stuck = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        const [key, msgs] = entry;
        const [tenantId, instanceName, telefone] = key.split('|');
        const token = tokenByKey.get(`${tenantId}|${instanceName}`);
        if (!token) continue;

        let serverRaw: unknown;
        try {
          const res = await firstValueFrom(
            this.http.post(
              `${this.baseUrl}/message/find`,
              { chatid: `${telefone}@s.whatsapp.net`, limit: 100 },
              { headers: { token }, timeout: 12_000 },
            ),
          );
          serverRaw = res.data;
        } catch (err) {
          this.logger.debug(`message/find ${instanceName}/${telefone} falhou: ${(err as Error).message}`);
          continue;
        }

        const dbMsgs: DbOutbound[] = msgs.map((m) => ({
          id: m.id,
          wamid: m.whatsapp_message_id as string,
          createdAt: m.created_at,
        }));
        const actions = planReconciliation(dbMsgs, parseServerMessages(serverRaw), {
          now: Date.now(),
          stuckAfterMs: StatusReconcilerService.STUCK_AFTER_MS,
        });
        if (actions.length === 0) continue;

        const byId = new Map(msgs.map((m) => [m.id, m]));
        for (const a of actions) {
          const msg = byId.get(a.id);
          if (!msg) continue;
          if (a.action === 'STUCK') {
            await this.markStuck(msg);
            stuck++;
          } else {
            await this.prisma.message.update({ where: { id: a.id }, data: { status: a.action } });
            this.gateway.emitMessageStatusUpdate(msg.lead_id, a.id, a.action);
            updated++;
          }
        }
        await this.invalidateCache(msgs[0].lead_id, tenantId);
      }
    };

    await Promise.all(
      Array.from({ length: StatusReconcilerService.CONCURRENCY }, () => worker()),
    );
    if (updated > 0 || stuck > 0) {
      this.logger.log(`reconciliação: ${updated} status atualizados, ${stuck} presas marcadas (${chats.size} chats na janela)`);
    }
  }

  /**
   * Presa confirmada: FAILED + wamid movido pra metadata (libera o resend) e,
   * pra texto recente, reenvio automático — o reenvio destrava (sessão nova).
   */
  private async markStuck(msg: {
    id: string;
    lead_id: string;
    whatsapp_message_id: string | null;
    created_at: Date;
    type: string;
    metadata: unknown;
  }): Promise<void> {
    const prevMeta = (msg.metadata && typeof msg.metadata === 'object')
      ? (msg.metadata as Record<string, unknown>)
      : {};
    await this.prisma.message.update({
      where: { id: msg.id },
      data: {
        status: 'FAILED',
        whatsapp_message_id: null,
        metadata: {
          ...prevMeta,
          send_error: 'stuck_sent: WhatsApp não entregou (preso em Sent no servidor; mensagens posteriores do chat já entregues)',
          stuck_wamid: msg.whatsapp_message_id,
          stuck_detected_at: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    this.gateway.emitMessageStatusUpdate(msg.lead_id, msg.id, 'FAILED');
    this.logger.warn(`msg ${msg.id} presa em Sent (wamid ${msg.whatsapp_message_id}) — marcada FAILED`);

    const resendCount = typeof prevMeta.resend_count === 'number' ? prevMeta.resend_count : 0;
    const youngEnough =
      Date.now() - msg.created_at.getTime() < StatusReconcilerService.AUTO_RESEND_MAX_AGE_MS;
    if (msg.type === 'TEXT' && youngEnough && resendCount < StatusReconcilerService.AUTO_RESEND_MAX_COUNT) {
      try {
        await this.messages.resend(msg.id, {}); // modo sistema
        this.logger.log(`msg ${msg.id} presa reenviada automaticamente`);
      } catch (err) {
        this.logger.debug(`auto-resend ${msg.id} falhou: ${(err as Error).message}`);
      }
    }
  }

  private async invalidateCache(leadId: string, tenantId: string): Promise<void> {
    await this.cache.delPattern?.(`messages:${leadId}:*`).catch(() => undefined);
    await this.cache.delPattern?.(`leads:list:${tenantId}:*`).catch(() => undefined);
  }
}
