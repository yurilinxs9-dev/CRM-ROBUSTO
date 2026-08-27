import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { InboundMessageService, type Obj } from './inbound-message.service';
import { normalizeAckUpdates, extractAck } from './ack-normalizer';
import { extractFromEvolution } from './message-extractor';
import { messageTs } from './history-sync';
import { HistorySyncService } from './history-sync.service';
import { InstanceHealthService } from '../instances/instance-health.service';
import { LogThrottle, INSTANCIA_DESCONHECIDA_JANELA_MS } from './log-throttle';

/**
 * Handlers dos eventos Evolution API v2 (messages.upsert/update,
 * connection.update, contacts.upsert, chats.update/upsert). Extraído do
 * WebhookProcessor (F2.2) — o processor só despacha pra cá.
 */
@Injectable()
export class EvolutionEventsHandler {
  private readonly logger = new Logger(EvolutionEventsHandler.name);
  /** Um aviso por instância órfã a cada 10min (ver avisarInstanciaDesconhecida). */
  private readonly avisoInstancia = new LogThrottle(INSTANCIA_DESCONHECIDA_JANELA_MS);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
    private gateway: CrmGateway,
    private inbound: InboundMessageService,
    private historySync: HistorySyncService,
    private instanceHealth: InstanceHealthService,
  ) {}

  /**
   * Webhook de instância que o CRM não conhece é condição ESPERADA, não erro:
   * alguém conectou uma instância direto no Evolution, o tenant foi deletado
   * ou está suspenso (o finder devolve null de propósito). Antes isso era um
   * `throw`: a BullMQ tentava 3x — retry que não pode dar certo, porque a
   * instância não aparece por insistir — e cuspia stack de `error` a CADA
   * mensagem, inundando o log pra sempre. Agora descarta com UM warn por
   * instância a cada 10min e o job completa.
   */
  private avisarInstanciaDesconhecida(evento: string, instanceName: string | undefined): void {
    const nome = instanceName ?? '(sem nome)';
    if (!this.avisoInstancia.deveLogar(nome)) return;
    this.logger.warn(
      `${evento}: mensagem descartada: instancia Evolution '${nome}' nao mapeada no CRM ` +
        `(tenant removido/suspenso ou conexao criada fora do CRM) — ` +
        `proximos avisos desta instancia suprimidos por 10min`,
    );
  }
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
      this.avisarInstanciaDesconhecida('messages.upsert', instanceName);
      return;
    }

    const messageId = key?.id as string | undefined;
    const isFromMe = !!(key?.fromMe as boolean);
    // Backfill (history sync) manda o telefone REAL do chat no payload —
    // cinto de segurança contra @lid sem PN em registros antigos.
    const chatPhone =
      data?.backfill === true && typeof data?.chat_phone === 'string'
        ? (data.chat_phone as string)
        : undefined;
    const phone = this.resolveEvolutionPhone(key, isFromMe) ?? chatPhone ?? null;
    if (!phone) {
      this.logger.warn(
        `Evolution message sem telefone resolvível — remoteJid=${remoteJid} (LID sem PN?) instance=${instanceName}`,
      );
      return;
    }
    const messageContent = msg?.message as Obj | undefined;
    const pushName = msg?.pushName as string | undefined;

    const extracted = extractFromEvolution(messageContent);

    // Job re-injetado pelo history sync: preserva o timestamp original e
    // suprime efeitos de "mensagem nova" (ver SaveMessageInput.backfill).
    const ts = messageTs(msg as Obj);
    const backfill =
      data?.backfill === true && ts > 0 ? { timestamp: new Date(ts) } : undefined;

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
      backfill,
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
        select: { id: true, lead_id: true, tenant_id: true, direction: true, created_at: true },
      });
      if (matches.length === 0) continue;

      await this.prisma.message.updateMany({
        where: { whatsapp_message_id: messageId },
        data: { status: mappedStatus as 'DELIVERED' | 'READ' | 'FAILED' },
      });
      for (const m of matches) {
        this.gateway.emitMessageStatusUpdate(m.lead_id, m.id, mappedStatus);
      }

      // READ em msg INCOMING = operador leu a conversa no celular/WhatsApp Web.
      // O `chats.update` do Evolution NÃO carrega unreadCount (payload vem só
      // com remoteJid), então este é o sinal confiável pra zerar o badge quando
      // a leitura acontece fora do CRM.
      //
      // SEMÂNTICA WHATSAPP: ler a mensagem N = leu TUDO até N. O aparelho só
      // manda ack da(s) última(s) visíveis — as INCOMING antigas do lead nunca
      // recebem ack individual e ficavam != READ pra sempre. O recálculo
      // ingênuo então RESSUSCITAVA a contagem histórica: abrir a conversa no
      // Web fazia o badge ir pra 21 em vez de sumir. Cascade primeiro: tudo
      // até o created_at da msg lida vira READ; o remaining conta só o que
      // chegou DEPOIS dela.
      if (mappedStatus !== 'READ') continue;
      const incomingLeads = new Map<string, { tenantId: string | null; upTo: Date }>();
      for (const m of matches) {
        if (m.direction !== 'INCOMING') continue;
        const prev = incomingLeads.get(m.lead_id);
        if (!prev || m.created_at > prev.upTo) {
          incomingLeads.set(m.lead_id, { tenantId: m.tenant_id, upTo: m.created_at });
        }
      }
      for (const [leadId, { tenantId, upTo }] of incomingLeads) {
        await this.prisma.message.updateMany({
          where: {
            lead_id: leadId,
            direction: 'INCOMING',
            status: { not: 'READ' },
            created_at: { lte: upTo },
          },
          data: { status: 'READ' },
        });
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
    if (!instance) {
      this.avisarInstanciaDesconhecida('connection.update', instanceName);
      return;
    }
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, status, instance.tenant_id);

    // Reconectou (close/connecting → open): re-sincroniza a última semana em
    // background — espelho WhatsApp Web: ficou fora, voltou, o histórico se
    // recompõe sozinho (o gateway Evolution guarda tudo no Postgres dele).
    if (status === 'open' && instance.status !== 'open') {
      void this.historySync
        .syncEvolutionInstance(instance.id, HistorySyncService.RECONNECT_WINDOW_MS)
        .catch((err) =>
          this.logger.warn(`history sync pós-reconexão (${instance.nome}): ${String(err)}`),
        );
      // Fecha o alerta do monitor na hora, sem esperar o próximo ciclo do cron.
      // Best-effort: alerta é aviso, nunca motivo pra retry do webhook.
      void this.instanceHealth
        .resolverAlerta(instance.id)
        .catch((err) =>
          this.logger.warn(`resolver alerta pós-reconexão (${instance.nome}): ${String(err)}`),
        );
    }
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
      this.avisarInstanciaDesconhecida('contacts.upsert', instanceName);
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
    if (!instance) {
      this.avisarInstanciaDesconhecida('chats.update', instanceName);
      return;
    }

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
