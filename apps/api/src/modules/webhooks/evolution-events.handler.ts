import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { InboundMessageService, type Obj } from './inbound-message.service';
import { normalizeAckUpdates, extractAck } from './ack-normalizer';
import { extractFromEvolution } from './message-extractor';

/**
 * Handlers dos eventos Evolution API v2 (messages.upsert/update,
 * connection.update, contacts.upsert, chats.update/upsert). Extraído do
 * WebhookProcessor (F2.2) — o processor só despacha pra cá.
 */
@Injectable()
export class EvolutionEventsHandler {
  private readonly logger = new Logger(EvolutionEventsHandler.name);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
    private gateway: CrmGateway,
    private inbound: InboundMessageService,
  ) {}
  /**
   * Resolve o telefone REAL do contato a partir da `key` Evolution/Baileys.
   *
   * WhatsApp vem migrando chats pra JIDs anônimos `@lid` (Linked ID). Extrair
   * dígitos de um `@lid` produz um "telefone" de 14-15 dígitos que não existe →
   * lead fantasma, duplicado do contato real (ocorreu na Cajuru: 252333791383591).
   * Pra @lid, o número verdadeiro vem nos campos PN que o Baileys/Evolution
   * anexa à key: `remoteJidAlt` (PN do chat) ou `senderPn` (PN de quem enviou —
   * só confiável quando !fromMe, senão é o nosso próprio número). Sem PN
   * resolvível, retorna null e o caller descarta com warn em vez de criar lead
   * com número inválido.
   */
  private resolveEvolutionPhone(key: Obj | undefined, isFromMe: boolean): string | null {
    const remoteJid = key?.remoteJid as string | undefined;
    if (!remoteJid) return null;
    const pnDigits = (jid: unknown): string | null => {
      if (typeof jid !== 'string' || !jid.includes('@s.whatsapp.net')) return null;
      const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 13 ? digits : null;
    };
    if (!remoteJid.endsWith('@lid')) {
      const digits = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
      return digits || null;
    }
    return (
      pnDigits(key?.remoteJidAlt) ??
      (!isFromMe ? pnDigits(key?.senderPn) : null) ??
      pnDigits(key?.participantAlt) ??
      null
    );
  }

  async handleMessageUpsert(data: Obj) {
    const rawData = data?.data as Obj | undefined;
    // Evolution v2.3.x: data.data = { key, message, pushName, ... } (key e
    // message são irmãos). Versões antigas aninhavam tudo em data.data.message.
    // Se já houver `key` no nível atual, este É o wrapper; senão desce um nível.
    const msg = (rawData?.key ? rawData : (rawData?.message ?? rawData)) as Obj | undefined;
    if (!msg) {
      this.logger.warn('Evolution payload sem message');
      return;
    }

    const instanceName = data?.instance as string | undefined;
    const key = msg?.key as Obj | undefined;
    const remoteJid = key?.remoteJid as string | undefined;
    if (!remoteJid) {
      this.logger.warn('Evolution message sem remoteJid');
      return;
    }
    if (remoteJid.includes('@g.us')) return; // group

    const instance = await this.inbound.findEvolutionInstanceByName(instanceName);
    if (!instance) {
      throw new Error(`Evolution instancia desconhecida: ${instanceName}`);
    }

    const messageId = key?.id as string | undefined;
    const isFromMe = !!(key?.fromMe as boolean);
    const phone = this.resolveEvolutionPhone(key, isFromMe);
    if (!phone) {
      this.logger.warn(
        `Evolution message sem telefone resolvível — remoteJid=${remoteJid} (LID sem PN?) instance=${instanceName}`,
      );
      return;
    }
    const messageContent = msg?.message as Obj | undefined;
    const pushName = msg?.pushName as string | undefined;

    const extracted = extractFromEvolution(messageContent);

    await this.inbound.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: data,
      lidJid: remoteJid.endsWith('@lid') ? remoteJid : undefined,
    });
  }

  async handleMessageUpdate(data: Obj) {
    // Evolution v2 envia `data` como OBJETO flat ({ keyId, status, ... }); o
    // shape Baileys/wppconnect antigo era um ARRAY de { key:{id}, update:{status} }.
    // Sem normalizar, o objeto flat caía no `!Array.isArray` e TODOS os acks de
    // entrega/leitura eram descartados — outbound Evolution ficava preso em SENT
    // (nunca ✓✓) e ERRO de entrega nunca virava FAILED visível.
    const updates = normalizeAckUpdates(data?.data);
    if (updates.length === 0) return;
    for (const update of updates) {
      const ack = extractAck(update);
      if (!ack) continue;
      const { messageId, status: mappedStatus } = ack;

      // wa_id deixou de ser único globalmente (composto com tenant_id), então
      // a mesma id pode aparecer em múltiplas perspectivas. updateMany cobre
      // todas; emitMessageStatusUpdate dispara por linha encontrada.
      const matches = await this.prisma.message.findMany({
        where: { whatsapp_message_id: messageId },
        select: { id: true, lead_id: true, tenant_id: true, direction: true },
      });
      if (matches.length === 0) continue;

      await this.prisma.message.updateMany({
        where: { whatsapp_message_id: messageId },
        data: { status: mappedStatus as 'DELIVERED' | 'READ' | 'FAILED' },
      });
      for (const m of matches) {
        this.gateway.emitMessageStatusUpdate(m.lead_id, m.id, mappedStatus);
      }

      // READ em msg INCOMING = operador leu a conversa no celular (app oficial
      // manda um ack por mensagem lida, `fromMe:false`). O `chats.update` do
      // Evolution NÃO carrega unreadCount (payload vem só com remoteJid), então
      // este é o único sinal confiável pra zerar o badge do CRM quando a leitura
      // acontece fora dele. Recalcula o contador em vez de zerar cego: se ainda
      // restam INCOMING não-lidas (ack parcial), o badge reflete o resto.
      if (mappedStatus !== 'READ') continue;
      const incomingLeads = new Map<string, string | null>();
      for (const m of matches) {
        if (m.direction === 'INCOMING') incomingLeads.set(m.lead_id, m.tenant_id);
      }
      for (const [leadId, tenantId] of incomingLeads) {
        const remaining = await this.prisma.message.count({
          where: { lead_id: leadId, direction: 'INCOMING', status: { not: 'READ' } },
        });
        await this.prisma.lead.updateMany({
          where: { id: leadId, mensagens_nao_lidas: { not: remaining } },
          data: { mensagens_nao_lidas: remaining },
        });
        if (remaining === 0) {
          this.gateway.emitLeadUnreadReset(leadId, tenantId ?? undefined);
        } else {
          this.gateway.emitLeadUpdated(
            leadId,
            { mensagens_nao_lidas: remaining },
            tenantId ?? undefined,
          );
        }
        if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
      }
    }
  }

  async handleConnectionUpdate(data: Obj) {
    const instanceName = data?.instance as string | undefined;
    const connectionData = data?.data as Obj | undefined;
    const rawState = (connectionData?.state as string | undefined) ?? 'disconnected';
    if (!instanceName) return;

    const stateMap: Record<string, string> = {
      connected: 'open',
      open: 'open',
      connecting: 'connecting',
      disconnected: 'close',
      close: 'close',
    };
    const status = stateMap[rawState] ?? rawState;

    const instance = await this.inbound.findEvolutionInstanceByName(instanceName);
    if (!instance) return;
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, status, instance.tenant_id);
  }

  async handleContactsUpsert(data: Obj) {
    const contacts = data?.data as Array<Obj> | undefined;
    if (!Array.isArray(contacts)) return;

    // SECURITY: scope updates to the instance's tenant. Without this, a contacts
    // webhook from one tenant would overwrite lead names/photos in all tenants
    // that happen to share the same phone number (cross-tenant data leakage
    // and the root cause of the "nomes iguais" bug seen in the chat list).
    const instanceName = data?.instance as string | undefined;
    const instance = await this.inbound.findEvolutionInstanceByName(instanceName);
    if (!instance) {
      this.logger.warn(
        `contacts.upsert ignorado — instancia desconhecida: ${instanceName}`,
      );
      return;
    }

    for (const contact of contacts) {
      const contactId = contact?.id as string | undefined;
      const phone = contactId?.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (!phone) continue;

      const nome = (contact?.pushName || contact?.name || undefined) as
        | string
        | undefined;
      // NOTE: deliberately NOT persisting `contact.profilePictureUrl` here.
      // Evolution forwards the raw `pps.whatsapp.net` signed URL, which expires
      // within hours and then returns 403. The avatar is mirrored to Supabase
      // Storage by `LeadsService.syncProfile()` (triggered on next inbound
      // message and by the daily cron), so we just skip the photo at this
      // bulk-upsert stage.
      if (!nome) continue;

      await this.prisma.lead.updateMany({
        where: {
          telefone: phone,
          tenant_id: instance.tenant_id,
          instancia_whatsapp: instance.nome,
          nome: phone, // only when still the placeholder
        },
        data: { nome },
      });
    }
  }

  /**
   * Evolution `chats.update`/`chats.upsert`: o WhatsApp avisa quando o estado de
   * leitura de um chat muda. Quando o operador lê a conversa no CELULAR (app
   * oficial), `unreadCount` cai a 0 — refletimos isso zerando as não-lidas no
   * CRM e marcando as INCOMING como READ, pra não ficar "não lida" no CRM depois
   * de já ter lido no celular (sincronização bidirecional do badge). Só agimos
   * quando unreadCount=0; valores >0 já são cobertos pelo fluxo de mensagem.
   */
  async handleChatsUpdate(data: Obj) {
    const instanceName = data?.instance as string | undefined;
    const instance = await this.inbound.findEvolutionInstanceByName(instanceName);
    if (!instance) return;

    const raw = data?.data;
    const chats = (Array.isArray(raw) ? raw : [raw]) as Array<Obj | undefined>;
    for (const chat of chats) {
      if (!chat) continue;
      const remoteJid =
        (chat.remoteJid as string | undefined) ?? (chat.id as string | undefined);
      if (!remoteJid || remoteJid.includes('@g.us')) continue;

      // unreadCount pode vir ausente (update parcial sem leitura) — só zeramos
      // quando explicitamente 0.
      const unread = chat.unreadCount;
      const isRead = unread === 0 || unread === '0';
      if (!isRead) continue;

      const phone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (!phone) continue;
      const lead = await this.prisma.lead.findFirst({
        where: { telefone: phone, tenant_id: instance.tenant_id },
        select: { id: true, mensagens_nao_lidas: true },
      });
      if (!lead || lead.mensagens_nao_lidas === 0) continue;

      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { mensagens_nao_lidas: 0 },
      });
      await this.prisma.message.updateMany({
        where: { lead_id: lead.id, direction: 'INCOMING', status: { not: 'READ' } },
        data: { status: 'READ' },
      });
      if (instance.tenant_id) await this.leadsService.invalidateLeadsCache(instance.tenant_id);
      this.gateway.emitLeadUnreadReset(lead.id, instance.tenant_id);
    }
  }
}
