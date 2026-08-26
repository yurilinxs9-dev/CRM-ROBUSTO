import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { InboundMessageService, type Obj } from './inbound-message.service';
import { extractFromUazapi, extractFromWpp, synthesizeMessageId } from './message-extractor';
import { messageTs, resolveUazapiPhone } from './history-sync';
import { HistorySyncService } from './history-sync.service';
import {
  LogThrottle,
  INSTANCIA_DESCONHECIDA_JANELA_MS,
  mascararToken,
} from './log-throttle';

/**
 * Handlers dos eventos UazAPI (messages, message_ack, connection, chats) e do
 * legado WPPConnect (onmessage, status-find). Extraído do WebhookProcessor
 * (F2.2) — o processor só despacha pra cá.
 */
@Injectable()
export class UazapiEventsHandler {
  private readonly logger = new Logger(UazapiEventsHandler.name);
  /** Um aviso por instância/token órfão a cada 10min (ver o handler Evolution). */
  private readonly avisoInstancia = new LogThrottle(INSTANCIA_DESCONHECIDA_JANELA_MS);

  constructor(
    private prisma: PrismaService,
    private gateway: CrmGateway,
    private inbound: InboundMessageService,
    private historySync: HistorySyncService,
  ) {}

  /**
   * Mesma condição esperada do handler Evolution (ver
   * `EvolutionEventsHandler.avisarInstanciaDesconhecida`): instância/token que
   * o CRM não conhece — ou tenant suspenso, que faz o finder devolver null de
   * propósito. Era `throw` → 3 retries inúteis + stack de `error` por mensagem.
   */
  private avisarInstanciaDesconhecida(evento: string, identificacao: string): void {
    if (!this.avisoInstancia.deveLogar(identificacao)) return;
    this.logger.warn(
      `${evento}: mensagem descartada: instancia ${identificacao} nao mapeada no CRM ` +
        `(tenant removido/suspenso ou conexao criada fora do CRM) — ` +
        `proximos avisos desta instancia suprimidos por 10min`,
    );
  }
  // ── WPPConnect handlers ──────────────────────────────────────────────────────

  async handleWppMessage(payload: Obj) {
    const instanceName = payload?.instance as string | undefined;
    const msg = payload?.data as Obj | undefined;
    if (!msg) {
      this.logger.warn('WPP payload sem data');
      return;
    }
    if (msg.isGroupMsg === true) return;

    const from = msg.from as string | undefined;
    if (!from) {
      this.logger.warn('WPP message sem from');
      return;
    }

    const instance = await this.inbound.findInstanceByName(instanceName);
    if (!instance) {
      this.avisarInstanciaDesconhecida('onmessage', `WPP '${instanceName ?? '(sem nome)'}'`);
      return;
    }

    const phone = from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const msgIdObj = msg.id as Obj | undefined;
    const messageId = (msgIdObj?._serialized as string) || (msg.id as string) || undefined;
    const isFromMe = (msg.fromMe as boolean) || false;
    const pushName = msg.pushName as string | undefined;

    const extracted = extractFromWpp(msg);

    await this.inbound.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: payload,
    });
  }

  async handleWppStatus(payload: Obj) {
    const instanceName = payload?.instance as string | undefined;
    if (!instanceName) return;

    const rawStatus = payload?.data as string | undefined;
    const statusMap: Record<string, string> = {
      CONNECTED: 'open',
      QRCODE: 'connecting',
      DISCONNECTED: 'close',
      DESTROYED: 'close',
      notLogged: 'close',
    };
    const status = (rawStatus && statusMap[rawStatus]) || 'disconnected';

    const instance = await this.inbound.findInstanceByName(instanceName);
    if (!instance) return;
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, status, instance.tenant_id);
  }

  // ── Evolution API handlers ──────────────────────────────────────────────────


  // ── UazAPI handlers ─────────────────────────────────────────────────────────

  async handleUazapiMessage(payload: Obj) {
    const message = payload?.message as Obj | undefined;
    if (!message) {
      this.logger.warn('UazAPI payload sem message');
      return;
    }
    if (message.isGroup === true) return;

    const chatid = message.chatid as string | undefined;
    if (!chatid) {
      this.logger.warn('UazAPI message sem chatid');
      return;
    }

    // Telefone LID-safe: chatid @lid tem dígitos que NÃO são telefone —
    // extrair cru criava lead fantasma de 14-15 dígitos (46 no banco antes
    // do fix). Backfill manda o telefone real do chat no payload; ao vivo
    // cai pro sender_pn; sem PN resolvível, descarta com warn.
    const chatPhone = payload.chat_phone as string | undefined;
    const phone = chatPhone ?? resolveUazapiPhone(message);
    if (!phone) {
      this.logger.warn(
        `UazAPI message sem telefone resolvível — chatid=${chatid} (LID sem PN?)`,
      );
      return;
    }
    const messageId = (message.messageid as string | undefined) ?? (message.id as string | undefined);
    const isFromMe = !!(message.fromMe as boolean | undefined);
    const pushName =
      (message.senderName as string | undefined) ?? (message.pushName as string | undefined);

    const token = payload.token as string | undefined;
    const instance = await this.inbound.findInstanceByUazapiToken(token);
    if (!instance) {
      this.avisarInstanciaDesconhecida('uazapi.messages', `UazAPI token ${mascararToken(token)}`);
      return;
    }

    const extracted = extractFromUazapi(message);

    // Job re-injetado pelo history sync: preserva o timestamp original e
    // suprime efeitos de "mensagem nova" (ver SaveMessageInput.backfill).
    const ts = messageTs(message);
    const backfill =
      payload.backfill === true && ts > 0 ? { timestamp: new Date(ts) } : undefined;

    await this.inbound.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: payload,
      backfill,
    });
  }

  async handleUazapiMessageAck(payload: Obj) {
    const message = (payload?.message ?? payload?.data) as Obj | undefined;
    if (!message) return;

    const messageId =
      (message.messageid as string | undefined) ?? (message.id as string | undefined);
    if (!messageId) return;

    const rawStatus = message.status as string | number | undefined;
    const statusMap: Record<string, 'SENT' | 'DELIVERED' | 'READ'> = {
      SENT: 'SENT',
      DELIVERED: 'DELIVERED',
      SERVER_ACK: 'SENT',
      DELIVERY_ACK: 'DELIVERED',
      READ: 'READ',
      PLAYED: 'READ',
      '2': 'SENT',
      '3': 'DELIVERED',
      '4': 'READ',
    };
    const mapped = rawStatus !== undefined ? statusMap[String(rawStatus)] : undefined;
    if (!mapped) return;

    const matches = await this.prisma.message.findMany({
      where: { whatsapp_message_id: messageId },
      select: { id: true, lead_id: true },
    });
    if (matches.length === 0) return;

    await this.prisma.message.updateMany({
      where: { whatsapp_message_id: messageId },
      data: { status: mapped },
    });
    for (const m of matches) {
      this.gateway.emitMessageStatusUpdate(m.lead_id, m.id, mapped);
    }
  }

  async handleUazapiConnectionUpdate(payload: Obj) {
    const instanceField = payload?.instance as Obj | undefined;
    const data = payload?.data as Obj | undefined;
    const rawState =
      (instanceField?.status as string | undefined) ??
      (data?.state as string | undefined) ??
      (data?.status as string | undefined) ??
      'disconnected';
    const stateMap: Record<string, string> = {
      connected: 'open',
      open: 'open',
      connecting: 'connecting',
      disconnected: 'close',
      close: 'close',
    };
    const status = stateMap[rawState] ?? rawState;

    const token = payload.token as string | undefined;
    const instance = await this.inbound.findInstanceByUazapiToken(token);
    if (!instance) return;

    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instance.nome, status, instance.tenant_id);

    // Reconectou (close/connecting → open): re-sincroniza a última semana em
    // background. É isso que faz o CRM se comportar como o WhatsApp Web —
    // ficou fora, voltou, o histórico se recompõe sozinho.
    if (status === 'open' && instance.status !== 'open') {
      void this.historySync
        .syncInstance(instance.id, HistorySyncService.RECONNECT_WINDOW_MS)
        .catch((err) =>
          this.logger.warn(`history sync pós-reconexão (${instance.nome}): ${String(err)}`),
        );
    }
  }

  async handleUazapiChats(payload: Obj) {
    const chat = payload?.chat as Obj | undefined;
    if (!chat) return;
    if (chat.wa_isGroup === true) return;

    const unreadCount = chat.wa_unreadCount as number | undefined;
    if (unreadCount !== 0) return; // Only act when conversation was read (unread → 0)

    // Extract phone: prefer wa_chatid (already normalized), fall back to chat.phone
    const chatId = chat.wa_chatid as string | undefined;
    const rawPhone = chat.phone as string | undefined;
    const phone = chatId
      ? chatId.split('@')[0].replace(/\D/g, '')
      : rawPhone?.replace(/\D/g, '') ?? '';
    if (!phone) return;

    const token = payload.token as string | undefined;
    const instance = await this.inbound.findInstanceByUazapiToken(token);
    if (!instance) return;

    const lead = await this.prisma.lead.findFirst({
      where: { telefone: phone, tenant_id: instance.tenant_id },
      select: { id: true, mensagens_nao_lidas: true },
    });
    if (!lead) return; // Lead doesn't exist in CRM — ignore
    if (lead.mensagens_nao_lidas === 0) return; // Already zero — no-op

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { mensagens_nao_lidas: 0 },
    });

    this.gateway.emitLeadUnreadReset(lead.id, instance.tenant_id);
  }
}
