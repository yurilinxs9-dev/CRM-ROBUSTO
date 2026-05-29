import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import type { AuthUser } from '../../common/types/auth-user';
import {
  addTagsSchema,
  listContactsQuerySchema,
  sendConversationSchema,
  updateStatusSchema,
} from './public-api.dto';
import { CONTACT_SELECT, toContactDto } from './public-serializers';

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

  // ---- Conversas (mensagens sobre um Lead) ----------------------------------

  /**
   * Inicia/continua uma conversa enviando uma mensagem ao contato.
   * Reusa MessagesService.sendText (mesma esteira UazAPI/fila/WS do app interno),
   * autenticando como o owner do tenant — a integração age em nome do workspace.
   */
  async sendMessage(tenantId: string, body: unknown) {
    const data = sendConversationSchema.parse(body);
    if (data.type !== 'text') {
      throw new BadRequestException('Apenas type "text" é suportado nesta versão.');
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id: data.user_id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Usuário não encontrado.');

    const actor = await this.ownerActor(tenantId);
    const message = await this.messages.sendText(
      { lead_id: data.user_id, content: data.message },
      actor,
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
