import { Injectable, Logger } from '@nestjs/common';
import type { MessageType, Prisma, WhatsappInstance } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { MediaService } from '../media/media.service';
import { MediaPipelineService } from '../media/media-pipeline.service';
import { PushService } from '../push/push.service';
import { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import { AssignmentService } from '../queue/assignment.service';
import { type ExtractedMessage, synthesizeMessageId } from './message-extractor';
import {
  assertValidMagic,
  decryptWhatsAppMedia,
  messageTypeToMediaType,
} from './media-crypto';

export type Obj = Record<string, unknown>;

/** Chaves base64 pesadas do payload do provider que nunca são lidas de volta
 *  (thumbnail já vira media_url via pipeline). Em jul/2026 ~23% das msgs
 *  carregavam jpegThumbnail (~9.5KB cada) dentro de metadata.raw. */
const HEAVY_RAW_KEYS = new Set(['jpegThumbnail', 'jpegthumbnail']);

/** Remove recursivamente as HEAVY_RAW_KEYS antes de persistir o raw. */
export function stripHeavyRawKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHeavyRawKeys);
  if (value !== null && typeof value === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      if (HEAVY_RAW_KEYS.has(k)) continue;
      out[k] = stripHeavyRawKeys(v);
    }
    return out;
  }
  return value;
}

interface PipelineCtx {
  pipeline: { id: string };
  firstStage: { id: string };
}

export interface SaveMessageInput {
  tenantId: string;
  instance: WhatsappInstance;
  phone: string;
  pushName?: string;
  messageId: string | undefined;
  isFromMe: boolean;
  extracted: ExtractedMessage;
  rawPayload: Obj;
  /** JID @lid do chat (Evolution) — persistido no lead pra envio LID-safe. */
  lidJid?: string;
}

/**
 * Núcleo do inbound — persistência de mensagem recebida, resolução de
 * lead/pipeline, mídia (download/decrypt/pipeline) e notificações. Extraído do
 * WebhookProcessor (F2.2): os handlers por provider ficam finos e este serviço
 * concentra a lógica compartilhada.
 */
@Injectable()
export class InboundMessageService {
  private readonly logger = new Logger(InboundMessageService.name);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
    private gateway: CrmGateway,
    private mediaService: MediaService,
    private mediaPipeline: MediaPipelineService,
    private push: PushService,
    private outboundWebhooks: OutboundWebhooksService,
    private assignment: AssignmentService,
  ) {}
  /**
   * F-02: setor sem agentes ativos — lead fica em espera (sem dono). Avisa os
   * supervisores (SUPER_ADMIN/GERENTE) por push para que alguém assuma.
   */
  private async notifyNoAgents(tenantId: string, leadId: string, leadNome: string) {
    const supervisors = await this.prisma.user.findMany({
      where: { tenant_id: tenantId, ativo: true, role: { in: ['SUPER_ADMIN', 'GERENTE'] } },
      select: { id: true },
    });
    if (supervisors.length === 0) return;
    void this.push.sendToUsers(
      supervisors.map((s) => s.id),
      {
        title: 'Lead sem setor disponível',
        body: `${leadNome} chegou mas o setor não tem atendentes ativos.`,
        url: `/chat/${leadId}`,
        tag: `no-agents-${leadId}`,
        data: { leadId, type: 'no_agents' },
      },
    );
  }


  // ── Helpers ─────────────────────────────────────────────────────────────────

  async findInstanceByName(name: string | undefined) {
    if (!name) return null;
    return this.prisma.whatsappInstance.findFirst({ where: { nome: name } });
  }

  /**
   * Resolve a instância de um webhook Evolution pelo nome.
   *
   * CRÍTICO: `nome` só é único POR tenant (@@unique([tenant_id, nome])), mas o
   * payload Evolution só carrega o nome — sem tenant. Quando dois tenants têm
   * instâncias homônimas (ex.: uma UazAPI antiga "teste" e uma Evolution nova
   * "teste"), o findFirst por nome cru pegava a errada → mensagens caíam no
   * tenant errado, emit ia pra sala errada e o usuário não via nada em tempo
   * real. Como nomes de instância são globalmente únicos no servidor Evolution,
   * escopar por provider='evolution' desambígua. Fallback ao nome cru só quando
   * não existe nenhuma instância Evolution com esse nome (compat com registros
   * antigos sem o campo provider).
   */
  async findEvolutionInstanceByName(name: string | undefined) {
    if (!name) return null;
    const evo = await this.prisma.whatsappInstance.findFirst({
      where: { nome: name, config: { path: ['provider'], equals: 'evolution' } },
    });
    return evo ?? this.findInstanceByName(name);
  }

  async findInstanceByUazapiToken(token: string | undefined) {
    if (!token) return null;
    return this.prisma.whatsappInstance.findFirst({
      where: { config: { path: ['uazapi_token'], equals: token } },
    });
  }

  /**
   * Ensures the tenant has at least one active pipeline + first stage.
   * Auto-creates a default pipeline "Principal" with stages "Novo / Em Atendimento / Ganho / Perdido"
   * if none exists — prevents silently dropping incoming messages.
   */
  private async ensurePipelineAndStage(tenantId: string): Promise<PipelineCtx | null> {
    let pipeline = await this.prisma.pipeline.findFirst({
      where: { ativo: true, tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
    });

    if (!pipeline) {
      this.logger.warn(`Nenhum pipeline para tenant ${tenantId}, criando default`);
      pipeline = await this.prisma.pipeline.create({
        data: {
          nome: 'Principal',
          descricao: 'Pipeline criado automaticamente',
          ativo: true,
          tenant_id: tenantId,
          stages: {
            create: [
              { nome: 'Novo', ordem: 0, cor: '#38bdf8', tenant_id: tenantId },
              { nome: 'Em Atendimento', ordem: 1, cor: '#fb923c', tenant_id: tenantId },
              { nome: 'Ganho', ordem: 2, cor: '#22c55e', is_won: true, tenant_id: tenantId },
              { nome: 'Perdido', ordem: 3, cor: '#ef4444', is_lost: true, tenant_id: tenantId },
            ],
          },
        },
      });
    }

    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id, tenant_id: tenantId },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) {
      this.logger.error(`Pipeline ${pipeline.id} sem stages — inconsistencia`);
      return null;
    }
    return { pipeline, firstStage };
  }

  /**
   * Downloads remote media to a buffer. Returns null on failure without throwing.
   */
  private async downloadMedia(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`Media download nao-OK: ${url} status=${res.status}`);
        return null;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      this.logger.warn(`Falha baixando media: ${url} — ${String(err)}`);
      return null;
    }
  }

  private extFromMime(mime: string | undefined, fallback: string): string {
    if (!mime) return fallback;
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'webm',
      'application/pdf': 'pdf',
    };
    if (map[mime]) return map[mime];
    const subtype = mime.split('/')[1];
    return subtype?.split(';')[0] ?? fallback;
  }

  /**
   * Uploads extracted media to Supabase Storage and returns the storage path.
   * Returns undefined if no URL or download/upload fails.
   */
  private async storeMedia(
    extracted: ExtractedMessage,
    tenantId: string,
    messageId: string,
  ): Promise<string | undefined> {
    const url = extracted.media?.url;
    if (!url || !/^https?:\/\//i.test(url)) return undefined;

    const buf = await this.downloadMedia(url);
    if (!buf) return undefined;

    const mimetype = extracted.media?.mimetype ?? 'application/octet-stream';
    const ext = this.extFromMime(mimetype, 'bin');
    const folder = extracted.type.toLowerCase();
    const path = `${tenantId}/${folder}/${messageId}.${ext}`;

    try {
      await this.mediaService.upload(path, buf, mimetype);
      return path;
    } catch (err) {
      this.logger.warn(`Falha upload media ${path}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Unified message persistence — optimized for realtime delivery.
   *
   * Critical-path order:
   *   1. ensure pipeline/lead (cheap)
   *   2. upsert message WITHOUT media (cheap)
   *   3. emit `message:new` IMMEDIATELY (text/control rendered instantly)
   *   4. background: download → upload → DB update → emit `message:media-ready`
   *
   * Why: previously the gateway waited for the Evolution media download
   * AND a Supabase upload before emitting, adding seconds of latency to every
   * voice note / image. Now text messages are <100ms p99 and media reaches the
   * client in two phases (skeleton then ready).
   */
  async saveIncomingMessage(input: SaveMessageInput): Promise<void> {
    const { tenantId, instance, phone, pushName, isFromMe, extracted, rawPayload, lidJid } = input;
    let { messageId } = input;

    if (!phone) {
      this.logger.warn(`Mensagem sem phone válido — instance=${instance.nome}`);
      return;
    }

    const ctx = await this.ensurePipelineAndStage(tenantId);
    if (!ctx) {
      this.logger.error(`Sem pipeline/stage para tenant ${tenantId} — mensagem perdida`);
      return;
    }

    // CRITICAL: never use `pushName` when isFromMe=true. The Evolution webhook
    // populates pushName from the SENDER, so for outgoing messages it is the
    // owner's own name (e.g. "Yuri Lins"), not the contact's. Writing it as
    // the lead `nome` corrupted every customer the user messaged into a
    // duplicate of the owner's name. Only trust pushName for incoming.
    const incomingPushName = !isFromMe && pushName ? pushName.trim() : undefined;

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { pool_enabled: true, round_robin_enabled: true },
    });

    // Instância dona de SUPER_ADMIN/GERENTE auto-atribui sempre ao dono,
    // mesmo com pool_enabled=true. Só OPERADOR cai no pool quando ativo.
    const ownerUser = instance.owner_user_id
      ? await this.prisma.user.findUnique({
          where: { id: instance.owner_user_id },
          select: { role: true },
        })
      : null;
    const ownerIsManager =
      ownerUser?.role === 'SUPER_ADMIN' || ownerUser?.role === 'GERENTE';
    // Modo Compartilhado para operador: lead entra sem dono (pool).
    const inPool = Boolean(tenant?.pool_enabled) && !ownerIsManager;
    const responsavelId = inPool ? null : instance.owner_user_id;
    // F-02: round-robin só quando o tenant ativou explicitamente (opt-in) E
    // está em modo Compartilhado. Caso contrário, comportamento atual intacto.
    const wantRoundRobin = inPool && tenant?.round_robin_enabled === true;

    // Escopo de identidade do lead: SEMPRE tenant_id → 1 lead por telefone+pipeline,
    // tanto no Compartilhado quanto no Individual. Antes o Individual escopava por
    // owner_user_id da instância, mas como um cliente fala com vários números da
    // empresa, cada instância criava um lead próprio → mesmo contato duplicado no
    // Kanban (inclusive pro mesmo operador após reassign). Isolamento cross-operador
    // fica por conta de responsavel_id + visibilidade, não da duplicação de linha.
    const leadScope = tenantId;

    const lead = await this.prisma.lead.upsert({
      where: {
        telefone_pipeline_scope: {
          telefone: phone,
          pipeline_id: ctx.pipeline.id,
          lead_scope: leadScope,
        },
      },
      create: {
        nome: incomingPushName || phone,
        telefone: phone,
        whatsapp_lid: lidJid,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instance.nome,
        lead_scope: leadScope,
        pipeline_id: ctx.pipeline.id,
        estagio_id: ctx.firstStage.id,
        estagio_entered_at: new Date(),
        responsavel_id: responsavelId,
        ultima_interacao: new Date(),
        last_customer_message_at: isFromMe ? undefined : new Date(),
        tenant_id: tenantId,
      },
      // Em update NÃO mexe em responsavel_id nem instancia_whatsapp:
      // se um operador já assumiu o lead (claim/reassign), as msgs novas
      // do cliente não podem reverter a posse pra o dono da instância.
      // O re-assign automático só acontece se o lead ainda está no pool
      // (responsavel_id IS NULL), tratado abaixo.
      update: {
        ultima_interacao: new Date(),
        last_customer_message_at: isFromMe ? undefined : new Date(),
        last_agent_message_at: isFromMe ? new Date() : undefined,
        mensagens_nao_lidas: isFromMe ? 0 : { increment: 1 },
        // Refresca o @lid a cada mensagem (leads antigos ganham o lid na
        // próxima interação; se o WhatsApp remapear o contato, atualiza).
        whatsapp_lid: lidJid ?? undefined,
      },
    });

    if (isFromMe) {
      this.gateway.emitLeadUnreadReset(lead.id, tenantId);
    }

    // Auto-assign só na situação clássica: lead em pool e dono da instância
    // é admin/gerente (modo Compartilhado) ou modo Individual. Nunca sobrepõe
    // claim humana.
    if (lead.responsavel_id === null && responsavelId !== null) {
      const fixed = await this.prisma.lead.update({
        where: { id: lead.id },
        data: { responsavel_id: responsavelId, instancia_whatsapp: instance.nome },
      });
      lead.responsavel_id = fixed.responsavel_id;
      lead.instancia_whatsapp = fixed.instancia_whatsapp;
    }

    // F-02: Round-robin por setor. Só para lead de CLIENTE (inbound) ainda no
    // pool. O lock no ponteiro (dentro de assignBySector) serializa concorrentes.
    // updateMany condicional (responsavel_id IS NULL) evita atribuição dupla se
    // duas mensagens do mesmo lead chegarem juntas.
    if (lead.responsavel_id === null && wantRoundRobin && !isFromMe) {
      const sectorId = await this.assignment.resolveSectorForInstance(
        tenantId,
        instance.sector_id,
      );
      const result = await this.assignment.assignBySector(tenantId, sectorId, lead.id);
      if (result.userId) {
        const upd = await this.prisma.lead.updateMany({
          where: { id: lead.id, responsavel_id: null },
          data: { responsavel_id: result.userId, instancia_whatsapp: instance.nome },
        });
        if (upd.count > 0) {
          lead.responsavel_id = result.userId;
          lead.instancia_whatsapp = instance.nome;
        }
      } else {
        // Setor sem agentes ativos → lead em espera; avisa supervisores.
        await this.notifyNoAgents(tenantId, lead.id, lead.nome);
      }
    }

    // Heal lead names that were corrupted before the fix above shipped.
    // If the stored name is the bare phone OR matches the owner's pushName
    // (i.e. previously corrupted), and we now have a real incoming pushName,
    // overwrite it.
    if (incomingPushName && lead.nome !== incomingPushName) {
      const looksCorrupted =
        lead.nome === lead.telefone || /^\+?\d{8,}$/.test(lead.nome.trim());
      if (looksCorrupted) {
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { nome: incomingPushName },
        });
        lead.nome = incomingPushName;
      }
    }

    // Synthesize id when webhook omits it — never drop the message
    if (!messageId) {
      messageId = synthesizeMessageId(lead.id);
      this.logger.warn(
        `messageId ausente — gerado sintetico ${messageId} para lead ${lead.id}`,
      );
    }

    const metadata: Prisma.InputJsonValue = {
      raw: stripHeavyRawKeys(
        JSON.parse(JSON.stringify(rawPayload)),
      ) as Prisma.InputJsonValue,
      ...(extracted.location ? { location: extracted.location } : {}),
      ...(extracted.contact ? { contact: extracted.contact } : {}),
    };

    // Echo dedup: when isFromMe=true, this webhook PODE ser o eco de uma
    // mensagem enviada pelo CRM (em que já criamos a linha + emitimos
    // message:new) — ou pode ser uma msg enviada DO CELULAR nativo, que é
    // first sight pra gente. A diferença está no whatsapp_message_id:
    //   - CRM-send → wa_id NULL ou UUID placeholder (esperando o eco
    //     trazer o id real do WhatsApp).
    //   - msg do celular → não há linha local, sempre cai no upsert+emit.
    //
    // Bug anterior: matchávamos por content+lead+direction nos últimos 2min.
    // Isso fazia msgs do celular com conteúdo idêntico a um CRM-send
    // recente serem "absorvidas" no eco — o webhook era ignorado, msg do
    // celular nunca aparecia em tempo real. Fix: janela curta (30s) +
    // confirmar que o wa_id local é placeholder antes de re-vincular.
    const isPlaceholderWaId = (id: string | null): boolean => {
      if (!id) return true;
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    };
    if (isFromMe) {
      const existingByWaId = await this.prisma.message.findUnique({
        where: {
          tenant_id_whatsapp_message_id: {
            tenant_id: tenantId,
            whatsapp_message_id: messageId,
          },
        },
      });
      if (existingByWaId) {
        this.logger.log(
          `dedup HIT existingByWaId msgId=${messageId} lead=${lead.id} — skip emit`,
        );
        return;
      }
      const recentLocal = await this.prisma.message.findFirst({
        where: {
          lead_id: lead.id,
          direction: 'OUTGOING',
          type: extracted.type as MessageType,
          content: extracted.content,
          created_at: { gte: new Date(Date.now() - 30 * 1000) },
        },
        orderBy: { created_at: 'desc' },
      });
      if (
        recentLocal &&
        recentLocal.whatsapp_message_id !== messageId &&
        isPlaceholderWaId(recentLocal.whatsapp_message_id)
      ) {
        this.logger.log(
          `dedup HIT recentLocal lead=${lead.id} localId=${recentLocal.id} ` +
          `localWaId=${recentLocal.whatsapp_message_id ?? 'null'} → ${messageId} — skip emit`,
        );
        await this.prisma.message.update({
          where: { id: recentLocal.id },
          data: { whatsapp_message_id: messageId },
        });
        return;
      }
      if (recentLocal) {
        this.logger.log(
          `dedup MISS lead=${lead.id} reason=${
            recentLocal.whatsapp_message_id === messageId ? 'same-id' : 'real-wa-id'
          } localWaId=${recentLocal.whatsapp_message_id ?? 'null'} — proceed upsert+emit`,
        );
      }
    }

    // Persist the message WITHOUT media first — keeps the realtime emit fast.
    // Race-safe: BullMQ may dispatch the same payload to two workers; the
    // upsert can lose the create→create race (P2002) before Prisma sees the
    // existing row. Catch and treat as "already saved by sibling worker".
    let message;
    try {
      message = await this.prisma.message.upsert({
      where: {
        tenant_id_whatsapp_message_id: {
          tenant_id: tenantId,
          whatsapp_message_id: messageId,
        },
      },
      create: {
        lead_id: lead.id,
        instance_name: instance.nome,
        whatsapp_message_id: messageId,
        direction: isFromMe ? 'OUTGOING' : 'INCOMING',
        type: extracted.type as MessageType,
        content: extracted.content,
        media_url: null,
        media_mimetype: extracted.media?.mimetype,
        media_duration_seconds: extracted.media?.duration_seconds,
        media_filename: extracted.media?.filename,
        media_size_bytes: extracted.media?.size_bytes,
        status: isFromMe ? 'SENT' : 'DELIVERED',
        // F-03: msg de entrada do cliente é neutra ('system'). isFromMe que chega
        // aqui (não foi deduplicado como eco de CRM/IA) é resposta NATIVA do humano
        // pelo celular → 'user' (bloqueia a IA). Ecos de envios do CRM/IA já
        // retornaram antes deste ponto, então nunca marcam 'user' por engano.
        sender_type: isFromMe ? 'user' : 'system',
        metadata,
        visible_to_user_id: lead.responsavel_id ?? null,
        tenant_id: tenantId,
      },
      update: {},
    });

    // F-03: humano respondeu pelo celular → trava a IA na conversa.
    if (isFromMe) {
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { ai_blocked: true },
      }).catch((err) => this.logger.warn(`ai_blocked set falhou lead=${lead.id}: ${String(err)}`));
    }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const existing = await this.prisma.message.findUnique({
          where: {
            tenant_id_whatsapp_message_id: {
              tenant_id: tenantId,
              whatsapp_message_id: messageId,
            },
          },
        });
        if (!existing) throw err;
        message = existing;
      } else {
        throw err;
      }
    }

    // Invalidate cache BEFORE emitting WS so client refetch hits a fresh list.
    // For media messages the client renders a placeholder (skeleton/loading)
    // until the `message:media-ready` event arrives.
    if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
    this.gateway.emitNewMessage(lead.id, message, tenantId);

    if (tenantId) {
      this.outboundWebhooks.dispatchMessageCreated({
        tenantId,
        messageId: message.id,
        leadId: lead.id,
        text: extracted.content ?? null,
        channel: 'whatsapp',
        direction: isFromMe ? 'outbound' : 'inbound',
        type: String(extracted.type),
      }).catch((err) => this.logger.warn(`dispatch message.created: ${String(err)}`));
    }

    if (!isFromMe) {
      const preview = extracted.content?.slice(0, 80) ?? `[${extracted.type}]`;
      const targetSet = new Set<string>();
      if (lead.responsavel_id) {
        targetSet.add(lead.responsavel_id);
      } else if (tenantId) {
        const poolUsers = await this.prisma.user.findMany({
          where: { tenant_id: tenantId, ativo: true, role: { not: 'VISUALIZADOR' } },
          select: { id: true },
        });
        poolUsers.forEach((u) => targetSet.add(u.id));
      }
      // Supervisão: SUPER_ADMIN/GERENTE acompanham TODAS as conversas do tenant
      // (modo Individual também). Sem isso, lead atribuído a um operador só
      // notificava o operador — o dono da operação nunca era avisado e a msg
      // "não chegava" pra ele apesar de estar no banco.
      if (tenantId) {
        const supervisors = await this.prisma.user.findMany({
          where: { tenant_id: tenantId, ativo: true, role: { in: ['SUPER_ADMIN', 'GERENTE'] } },
          select: { id: true },
        });
        supervisors.forEach((s) => targetSet.add(s.id));
      }
      const targetUserIds = [...targetSet];
      if (targetUserIds.length > 0) {
        // Nome do dono do lead — usado pra etiquetar no sino do supervisor
        // ("Equipe · Alex"). Pro próprio dono fica NULL ("Seus leads").
        const responsavelNome = lead.responsavel_id
          ? (await this.prisma.user.findUnique({
              where: { id: lead.responsavel_id },
              select: { nome: true },
            }))?.nome ?? null
          : null;
        void this.push.sendToUsers(targetUserIds, {
          title: lead.nome,
          body: preview,
          url: `/chat/${lead.id}`,
          tag: `msg-${lead.id}`,
          data: { leadId: lead.id, type: 'message' },
        });
        void this.createMessageNotifications(
          targetUserIds,
          tenantId,
          lead.id,
          lead.nome,
          preview,
          lead.responsavel_id ?? null,
          responsavelNome,
        );
      }
    }

    // Background: download from Evolution, upload to Supabase, sign,
    // patch DB, and emit a media-ready event so the client renders the audio.
    if (extracted.media?.url) {
      void this.processMediaInBackground({
        tenantId,
        leadId: lead.id,
        messageId: message.id,
        whatsappMessageId: messageId,
        extracted,
      });
    }

    // Sync profile (name + photo) in background — never blocks realtime.
    // Trigger when name is placeholder, photo is missing, OR stored URL is a
    // raw WhatsApp CDN link (`pps.whatsapp.net`) which expires within hours
    // and starts returning 403 once the `oe=` timestamp passes.
    const fotoStale = lead.foto_url?.includes('pps.whatsapp.net') ?? false;
    if (lead.nome === lead.telefone || !lead.foto_url || fotoStale) {
      void this.leadsService.syncProfileSafe(lead.id);
    }
  }

  /**
   * Notificação in-app: mantém 1 entrada NÃO-LIDA por conversa por usuário
   * (atualiza a existente em vez de empilhar) e emite via WS pro sino do Header.
   * Off-critical-path (chamado com void).
   */
  private async createMessageNotifications(
    userIds: string[],
    tenantId: string,
    leadId: string,
    leadNome: string,
    preview: string,
    responsavelId: string | null,
    responsavelNome: string | null,
  ): Promise<void> {
    const link = `/chat/${leadId}`;
    await Promise.all(
      userIds.map(async (uid) => {
        // Pro dono do lead (ou lead sem dono) → NULL = "Seus leads".
        // Pro supervisor → nome do operador = agrupa "Equipe · {nome}".
        const label = uid === responsavelId ? null : responsavelNome;
        try {
          const existing = await this.prisma.notification.findFirst({
            where: { user_id: uid, tenant_id: tenantId, tipo: 'message', link, lida: false },
            select: { id: true },
          });
          const notif = existing
            ? await this.prisma.notification.update({
                where: { id: existing.id },
                data: { titulo: leadNome, conteudo: preview, responsavel_nome: label, created_at: new Date() },
              })
            : await this.prisma.notification.create({
                data: {
                  user_id: uid,
                  tenant_id: tenantId,
                  titulo: leadNome,
                  conteudo: preview,
                  tipo: 'message',
                  link,
                  responsavel_nome: label,
                  lida: false,
                },
              });
          this.gateway.emitNotification(uid, notif);
        } catch (err) {
          this.logger.warn(`Falha criando notificação in-app p/ ${uid}: ${String(err)}`);
        }
      }),
    );
  }

  /**
   * Off-critical-path: download remote media → upload to Supabase Storage →
   * update message row → emit `message:media-ready` so the client patches
   * the cached message and the audio/image renders without a refresh.
   *
   * For IMAGE and VIDEO messages, also runs MediaPipelineService to extract
   * thumbnail/poster and dimension metadata.
   */
  private async processMediaInBackground(input: {
    tenantId: string;
    leadId: string;
    messageId: string;
    whatsappMessageId: string;
    extracted: ExtractedMessage;
  }): Promise<void> {
    try {
      // Download the raw buffer once so we can reuse it for pipeline processing.
      const mediaUrl = input.extracted.media?.url;
      if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) return;

      const rawBuf = await this.downloadMedia(mediaUrl);
      if (!rawBuf) return;

      const mimetype = input.extracted.media?.mimetype ?? 'application/octet-stream';
      const mediaKey = input.extracted.media?.mediaKey;

      // Decrypt WhatsApp E2E encrypted media if mediaKey is present.
      let buf: Buffer;
      if (mediaKey) {
        try {
          const cryptoType = messageTypeToMediaType(input.extracted.type);
          buf = decryptWhatsAppMedia(rawBuf, mediaKey, cryptoType);
        } catch (err) {
          this.logger.error(
            `Decryption failed msg=${input.messageId} waId=${input.whatsappMessageId}: ${String(err)}`,
          );
          return;
        }
      } else {
        // No mediaKey — assume already decrypted (e.g. from APIs that handle decryption).
        buf = rawBuf;
      }

      // Validate magic bytes — never store corrupted/encrypted data.
      try {
        assertValidMagic(buf, mimetype, input.messageId);
      } catch (err) {
        this.logger.error(String(err));
        return;
      }

      const ext = this.extFromMime(mimetype, 'bin');
      const folder = input.extracted.type.toLowerCase();
      const storagePath = `${input.tenantId}/${folder}/${input.whatsappMessageId}.${ext}`;

      try {
        await this.mediaService.upload(storagePath, buf, mimetype);
      } catch (err) {
        this.logger.warn(`Falha upload media ${storagePath}: ${String(err)}`);
        return;
      }

      // Base DB update.
      const dbUpdate: Record<string, unknown> = { media_url: storagePath };

      // Enhanced processing for IMAGE and VIDEO.
      if (input.extracted.type === 'IMAGE') {
        try {
          const pipe = await this.mediaPipeline.processImage(buf);
          const thumbPath = `${input.tenantId}/image/${input.whatsappMessageId}.thumb.jpg`;
          await this.mediaService.upload(thumbPath, pipe.thumbnail.buffer, pipe.thumbnail.mimetype);
          dbUpdate['media_thumbnail_path'] = thumbPath;
          if (pipe.width != null)  dbUpdate['media_width']  = pipe.width;
          if (pipe.height != null) dbUpdate['media_height'] = pipe.height;
        } catch (err) {
          this.logger.warn(`Image pipeline failed for ${input.whatsappMessageId}: ${String(err)}`);
        }
      } else if (input.extracted.type === 'VIDEO') {
        try {
          const pipe = await this.mediaPipeline.processVideo(buf, mimetype);
          const posterPath = `${input.tenantId}/video/${input.whatsappMessageId}.poster.jpg`;
          await this.mediaService.upload(posterPath, pipe.poster.buffer, pipe.poster.mimetype);
          dbUpdate['media_poster_path'] = posterPath;
          if (pipe.width != null)             dbUpdate['media_width']            = pipe.width;
          if (pipe.height != null)            dbUpdate['media_height']           = pipe.height;
          if (pipe.duration_seconds != null)  dbUpdate['media_duration_seconds'] = pipe.duration_seconds;
        } catch (err) {
          this.logger.warn(`Video pipeline failed for ${input.whatsappMessageId}: ${String(err)}`);
        }
      }

      await this.prisma.message.update({
        where: { id: input.messageId },
        data: dbUpdate as Prisma.MessageUpdateInput,
      });

      let signedUrl: string | null = null;
      try {
        signedUrl = await this.mediaService.getSignedUrl(storagePath, 60 * 60);
      } catch (err) {
        this.logger.warn(
          `Falha assinando media ${storagePath}: ${String(err)}`,
        );
      }
      if (!signedUrl) return;

      this.gateway.emitMessageMediaReady(input.leadId, {
        messageId: input.messageId,
        media_url: signedUrl,
        media_mimetype: input.extracted.media?.mimetype ?? null,
      });
    } catch (err) {
      this.logger.error(
        `processMediaInBackground falhou para ${input.whatsappMessageId}: ${String(err)}`,
      );
    }
  }
}
