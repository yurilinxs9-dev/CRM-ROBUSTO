import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import type { AuthUser } from '../../common/types/auth-user';
import {
  addTagsSchema,
  conversationMessagesQuerySchema,
  createContactSchema,
  listContactsQuerySchema,
  listConversationsQuerySchema,
  moveToSectorSchema,
  sendConversationSchema,
  updateContactSchema,
  updateStatusSchema,
} from './public-api.dto';
import {
  CONTACT_SELECT,
  MESSAGE_SELECT,
  toContactDto,
  toMessageDto,
} from './public-serializers';

/** Aceita vários sinônimos PT/EN → enum canônico de status de conversa. */
const STATUS_MAP: Record<string, ConversationStatus> = {
  open: ConversationStatus.OPEN,
  aberta: ConversationStatus.OPEN,
  aberto: ConversationStatus.OPEN,
  pending: ConversationStatus.PENDING,
  in_progress: ConversationStatus.PENDING,
  'em andamento': ConversationStatus.PENDING,
  andamento: ConversationStatus.PENDING,
  pendente: ConversationStatus.PENDING,
  resolved: ConversationStatus.RESOLVED,
  closed: ConversationStatus.RESOLVED,
  fechada: ConversationStatus.RESOLVED,
  fechado: ConversationStatus.RESOLVED,
  resolvido: ConversationStatus.RESOLVED,
  resolvida: ConversationStatus.RESOLVED,
};

@Injectable()
export class PublicApiService {
  private readonly logger = new Logger(PublicApiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly leads: LeadsService,
    private readonly gateway: CrmGateway,
  ) {}

  // ---- Contatos (Leads) -----------------------------------------------------

  async listContacts(tenantId: string, query: unknown) {
    const q = listContactsQuerySchema.parse(query);
    const where: Record<string, unknown> = { tenant_id: tenantId };
    if (q.email) where.email = q.email;
    if (q.phone) {
      const digits = q.phone.replace(/\D/g, '');
      where.telefone = { contains: digits || q.phone };
    }

    const [total, leads] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: { ultima_interacao: 'desc' },
        take: q.limit,
        skip: q.offset,
        select: CONTACT_SELECT,
      }),
    ]);

    return {
      data: leads.map(toContactDto),
      pagination: { total, limit: q.limit, offset: q.offset },
    };
  }

  async getContact(tenantId: string, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: tenantId },
      select: CONTACT_SELECT,
    });
    if (!lead) throw new NotFoundException('Usuário não encontrado.');
    return toContactDto(lead);
  }

  /** Cria um contato (Lead). Resolve pipeline/stage/instância default do tenant. */
  async createContact(tenantId: string, body: unknown) {
    const d = createContactSchema.parse(body);

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { tenant_id: tenantId },
      orderBy: { ordem: 'asc' },
      select: { id: true, stages: { orderBy: { ordem: 'asc' }, take: 1, select: { id: true } } },
    });
    if (!pipeline || !pipeline.stages[0]) {
      throw new BadRequestException('Tenant sem pipeline/estágio configurado.');
    }

    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { tenant_id: tenantId },
      orderBy: [{ ultimo_check: 'desc' }, { created_at: 'asc' }],
      select: { nome: true },
    });

    const phone = d.phone.replace(/\D/g, '') || d.phone;
    const lead = await this.prisma.lead.create({
      data: {
        nome: d.name,
        telefone: phone,
        email: d.email ?? null,
        tags: d.tags ?? [],
        origem: 'MANUAL',
        tenant_id: tenantId,
        pipeline_id: pipeline.id,
        estagio_id: pipeline.stages[0].id,
        instancia_whatsapp: inst?.nome ?? '',
        responsavel_id: null,
        // Sem dono definido na API → escopo tenant-wide (seed). Inbound de um
        // número específico em modo Individual pode gerar lead próprio depois.
        lead_scope: tenantId,
      },
      select: CONTACT_SELECT,
    });

    await this.prisma.leadActivity.create({
      data: {
        lead_id: lead.id,
        tipo: 'api_contact_created',
        descricao: 'Contato criado via API',
        tenant_id: tenantId,
      },
    });

    return toContactDto(lead);
  }

  /** Atualiza um contato (nome, email e/ou tags). */
  async updateContact(tenantId: string, id: string, body: unknown) {
    const d = updateContactSchema.parse(body);
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Usuário não encontrado.');

    const data: Record<string, unknown> = {};
    if (d.name !== undefined) data.nome = d.name;
    if (d.email !== undefined) data.email = d.email;
    if (d.tags !== undefined) data.tags = d.tags;

    const updated = await this.prisma.lead.update({ where: { id }, data, select: CONTACT_SELECT });
    this.gateway.emitLeadUpdated(id, data, tenantId);
    return toContactDto(updated);
  }

  // ---- Conversas (mensagens sobre um Lead) ----------------------------------

  /** Lista conversas (contatos) com filtro opcional por status e tag. */
  async listConversations(tenantId: string, query: unknown) {
    const q = listConversationsQuerySchema.parse(query);
    const where: Record<string, unknown> = { tenant_id: tenantId };
    if (q.status) where.atendimento_status = q.status.toUpperCase();
    if (q.tag) where.tags = { array_contains: q.tag };

    const [total, leads] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: { ultima_interacao: 'desc' },
        take: q.limit,
        skip: q.offset,
        select: CONTACT_SELECT,
      }),
    ]);

    return {
      data: leads.map((l) => ({
        conversation_id: l.id,
        contact: toContactDto(l),
        status: l.atendimento_status,
      })),
      pagination: { total, limit: q.limit, offset: q.offset },
    };
  }

  /** Retorna a conversa: contato + mensagens recentes (exclui notas internas). */
  async getConversation(tenantId: string, conversationId: string, query: unknown) {
    const q = conversationMessagesQuerySchema.parse(query);
    const lead = await this.prisma.lead.findFirst({
      where: { id: conversationId, tenant_id: tenantId },
      select: CONTACT_SELECT,
    });
    if (!lead) throw new NotFoundException('Conversa não encontrada.');

    const messages = await this.prisma.message.findMany({
      where: { lead_id: conversationId, tenant_id: tenantId, is_internal_note: false },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      select: MESSAGE_SELECT,
    });

    return {
      conversation_id: conversationId,
      contact: toContactDto(lead),
      status: lead.atendimento_status,
      messages: messages.map(toMessageDto),
      pagination: { limit: q.limit, count: messages.length },
    };
  }

  /**
   * Inicia/continua uma conversa enviando uma mensagem ao contato.
   * Reusa MessagesService.sendText (mesma esteira UazAPI/fila/WS do app interno),
   * autenticando como o owner do tenant — a integração age em nome do workspace.
   */
  async sendMessage(tenantId: string, body: unknown, isAi = false) {
    const data = sendConversationSchema.parse(body);
    if (data.type !== 'text') {
      throw new BadRequestException('Apenas type "text" é suportado nesta versão.');
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id: data.user_id, tenant_id: tenantId },
      select: { id: true, ai_blocked: true },
    });
    if (!lead) throw new NotFoundException('Usuário não encontrado.');

    // F-03: a IA respeita a trava da conversa. Se um humano interferiu
    // (ai_blocked=true), a IA não envia nada — retorna 'skipped' sem erro.
    if (isAi && lead.ai_blocked) {
      return {
        id: null,
        conversation_id: data.user_id,
        status: 'skipped',
        reason: 'ai_blocked',
        channel: data.channel,
        type: data.type,
      };
    }

    // Chave is_ai → 'ai' (sujeito à trava); demais integrações → 'system' (neutro,
    // nunca bloqueia a IA). Humano via app/web continua sendo 'user' no outro path.
    const senderType = isAi ? 'ai' : 'system';

    const actor = await this.ownerActor(tenantId);
    const message = await this.messages.sendText(
      { lead_id: data.user_id, content: data.message },
      actor,
      { senderType },
    );

    return {
      id: message.id,
      conversation_id: data.user_id,
      status: 'queued',
      channel: data.channel,
      type: data.type,
      created_at: message.created_at.toISOString(),
    };
  }

  async updateStatus(tenantId: string, conversationId: string, body: unknown) {
    const { status } = updateStatusSchema.parse(body);
    const mapped = STATUS_MAP[status.toLowerCase().trim()];
    if (!mapped) {
      throw new BadRequestException(
        `Status inválido: "${status}". Use open | pending | resolved.`,
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id: conversationId, tenant_id: tenantId },
      select: { id: true, atendimento_status: true },
    });
    if (!lead) throw new NotFoundException('Conversa não encontrada.');

    if (lead.atendimento_status !== mapped) {
      await this.prisma.lead.update({
        where: { id: conversationId },
        data: { atendimento_status: mapped },
      });
      await this.prisma.leadActivity.create({
        data: {
          lead_id: conversationId,
          tipo: 'api_status_changed',
          descricao: `Status alterado para ${mapped} via API`,
          tenant_id: tenantId,
        },
      });
      this.gateway.emitLeadUpdated(conversationId, { atendimento_status: mapped }, tenantId);
    }

    return { conversation_id: conversationId, status: mapped };
  }

  async addTags(tenantId: string, conversationId: string, body: unknown) {
    const { tags } = addTagsSchema.parse(body);

    const lead = await this.prisma.lead.findFirst({
      where: { id: conversationId, tenant_id: tenantId },
      select: { id: true, tags: true },
    });
    if (!lead) throw new NotFoundException('Conversa não encontrada.');

    const names = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

    // Upsert das Tags (catálogo do tenant) + relação LeadTag (idempotente).
    const tagRecords = await Promise.all(
      names.map((nome) =>
        this.prisma.tag.upsert({
          where: { tenant_id_nome: { tenant_id: tenantId, nome } },
          update: {},
          create: { nome, tenant_id: tenantId },
          select: { id: true, nome: true },
        }),
      ),
    );

    await this.prisma.leadTag.createMany({
      data: tagRecords.map((t) => ({
        lead_id: conversationId,
        tag_id: t.id,
        tenant_id: tenantId,
      })),
      skipDuplicates: true,
    });

    // Espelha no campo Lead.tags (JSON) — o app interno lê tags daqui também.
    const existing = Array.isArray(lead.tags) ? (lead.tags as string[]) : [];
    const merged = [...new Set([...existing, ...names])];
    await this.prisma.lead.update({
      where: { id: conversationId },
      data: { tags: merged },
    });

    this.gateway.emitLeadUpdated(conversationId, { tags: merged }, tenantId);

    return { conversation_id: conversationId, tags: merged };
  }

  // ---- Setores --------------------------------------------------------------

  /** Lista os setores ativos do tenant (para descobrir o sector_id). */
  async listSectors(tenantId: string) {
    const sectors = await this.prisma.sector.findMany({
      where: { tenant_id: tenantId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    return { data: sectors };
  }

  /**
   * Move a conversa (lead) para um setor. Reusa LeadsService.moveToSector —
   * mesma esteira do app interno: round-robin entre os agentes ativos do setor
   * (compartilha o ponteiro da fila com o webhook de entrada). Setor sem agentes
   * ativos → lead fica em espera no pool.
   */
  async moveToSector(tenantId: string, conversationId: string, body: unknown) {
    const { sector_id } = moveToSectorSchema.parse(body);

    const lead = await this.prisma.lead.findFirst({
      where: { id: conversationId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Conversa não encontrada.');

    const actor = await this.ownerActor(tenantId);
    const result = await this.leads.moveToSector(conversationId, { sectorId: sector_id }, actor);

    return {
      conversation_id: conversationId,
      sector_id: result.sector_id,
      responsavel_id: result.responsavel_id,
      status: result.responsavel_id ? 'assigned' : 'waiting',
    };
  }

  // ---- Helpers --------------------------------------------------------------

  /** Constrói um AuthUser sintético = owner do tenant, para reusar os services internos. */
  private async ownerActor(tenantId: string): Promise<AuthUser> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        owner: { select: { id: true, nome: true, email: true, role: true, ativo: true } },
      },
    });
    if (!tenant?.owner) {
      throw new NotFoundException('Tenant sem owner — não é possível enviar mensagem.');
    }
    const o = tenant.owner;
    return {
      id: o.id,
      nome: o.nome,
      email: o.email,
      role: o.role,
      ativo: o.ativo,
      tenantId,
    };
  }
}
