import { Injectable, BadRequestException, ForbiddenException, ConflictException, NotFoundException, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { isPlSalesOnly } from '../../common/access/pl-sales-access';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { SectorsService } from '../sectors/sectors.service';
import {
  KanbanIndividualService,
  TX_OPTS,
  temBoardProprio,
} from '../pipelines/kanban-individual.service';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const TEAM_SELECT = {
  id: true,
  nome: true,
  email: true,
  role: true,
  ativo: true,
  avatar_url: true,
  titulo: true,
  especialidade: true,
  created_at: true,
  sector_id: true,
  pl_sales_only: true,
  sector: { select: { id: true, name: true } },
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private media: MediaService,
    private sectors: SectorsService,
    private kanbanIndividual: KanbanIndividualService,
    @Optional() private cache?: RedisCacheService,
    @Optional() private gateway?: CrmGateway,
  ) {}

  private validatePlProfile(caller: AuthUser, role: string, enabled: boolean | undefined) {
    if (enabled === undefined) return;
    if (!['GERENTE', 'SUPER_ADMIN'].includes(caller.role)) throw new ForbiddenException('Somente a gestão pode definir o perfil de acesso.');
    if (enabled && caller.tenantId !== 'a44772ed-1382-4400-84fc-3fa350e23e42') throw new ForbiddenException('Perfil disponível somente no workspace PL.');
    if (enabled && role !== 'OPERADOR') throw new BadRequestException('O perfil de vendedora de consórcio exige o papel Operador.');
  }

  private async refreshAccess(userId: string) {
    await this.cache?.del(`auth:user:${userId}`);
    this.gateway?.disconnectUser(userId);
  }

  /**
   * Kanban individual: membro que entra na equipe DEPOIS do toggle ligado
   * precisa ganhar a copia das colunas base agora — `enable()` clonou uma vez
   * so, para quem ja estava no tenant. Sem isto o Kanban do contratado novo
   * abre em branco, sem erro nenhum, ate alguem desligar e religar a feature.
   *
   * Idempotente (quem ja tem colunas nao ganha um segundo conjunto) e
   * ACESSORIO: o usuario ja esta gravado quando isto roda, entao uma falha aqui
   * vira log — nunca um 500 numa criacao que deu certo. Papel sem board
   * (VISUALIZADOR) le a base e nao clona nada.
   */
  private async garantirBoardDoMembro(
    tenantId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    try {
      if (!temBoardProprio(role)) return;
      if (!(await this.kanbanIndividual.isOn(tenantId))) return;
      const jaTem = await this.prisma.stage.count({
        where: { tenant_id: tenantId, user_id: userId },
      });
      if (jaTem > 0) return;
      await this.prisma.$transaction(
        (tx) => this.kanbanIndividual.cloneBaseForUser(tx, tenantId, userId),
        TX_OPTS,
      );
    } catch (err) {
      this.logger.error(
        `kanban individual: falha ao clonar o board do membro ${userId} (tenant ${tenantId}): ${String(err)}`,
      );
    }
  }

  findAll(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId },
      select: TEAM_SELECT,
      orderBy: { nome: 'asc' },
    });
  }

  async createTeamMember(
    caller: AuthUser,
    dto: { nome: string; email: string; senha: string; role: string; sector_id?: string | null; pl_sales_only?: boolean },
  ) {
    this.validatePlProfile(caller, dto.role, dto.pl_sales_only);
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível criar SUPER_ADMIN');
    }
    const validRoles = [UserRole.GERENTE, UserRole.OPERADOR, UserRole.VISUALIZADOR];
    if (!validRoles.includes(dto.role as UserRole)) {
      throw new BadRequestException('Role inválida');
    }
    // Setor é opcional; quando informado, valida que existe, é do tenant e está ativo.
    const sectorId = dto.sector_id
      ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
      : null;
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email já cadastrado');

    const senha_hash = await bcrypt.hash(dto.senha, 12);
    const userId = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "User" (id, nome, email, senha_hash, role, ativo, tenant_id, sector_id, pl_sales_only, created_at, updated_at)
      VALUES (${userId}, ${dto.nome}, ${dto.email}, ${senha_hash}, ${dto.role}::"UserRole", true, ${caller.tenantId}, ${sectorId}, ${dto.pl_sales_only ?? false}, NOW(), NOW())
    `;
    await this.garantirBoardDoMembro(caller.tenantId, userId, dto.role);
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: TEAM_SELECT });
  }

  async linkTeamMember(caller: AuthUser, dto: { email: string; role: string; sector_id?: string | null; pl_sales_only?: boolean }) {
    this.validatePlProfile(caller, dto.role, dto.pl_sales_only);
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível vincular como SUPER_ADMIN');
    }
    const target = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!target) throw new NotFoundException('Usuário não encontrado');
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível vincular SUPER_ADMIN');
    }
    if (target.tenant_id === caller.tenantId) {
      throw new ConflictException('Usuário já faz parte da equipe');
    }
    const sectorId = dto.sector_id
      ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
      : null;
    const vinculado = await this.prisma.user.update({
      where: { id: target.id },
      data: { tenant_id: caller.tenantId, role: dto.role as UserRole, sector_id: sectorId, pl_sales_only: dto.pl_sales_only ?? false },
      select: TEAM_SELECT,
    });
    // Vincular e a outra porta de entrada da equipe: o efeito no board e o
    // mesmo de criar do zero.
    await this.garantirBoardDoMembro(caller.tenantId, target.id, dto.role);
    await this.refreshAccess(target.id);
    return vinculado;
  }

  async updateTeamMember(
    caller: AuthUser,
    targetId: string,
    dto: {
      nome?: string;
      email?: string;
      senha?: string;
      role?: string;
      titulo?: string | null;
      especialidade?: string | null;
      ativo?: boolean;
      sector_id?: string | null;
      pl_sales_only?: boolean;
    },
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, tenant_id: true, pl_sales_only: true, email: true, is_platform_admin: true },
    });
    if (!target || target.tenant_id !== caller.tenantId) throw new NotFoundException();
    const mexeCredenciais = dto.email !== undefined || dto.senha !== undefined;
    if (mexeCredenciais) this.assertCanManageCredentials(caller, target);
    this.validatePlProfile(caller, dto.role ?? target.role, dto.pl_sales_only);
    if (target.pl_sales_only && dto.role && dto.role !== 'OPERADOR' && dto.pl_sales_only !== false) throw new BadRequestException('Desative o perfil restrito antes de mudar o papel deste membro.');
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível editar SUPER_ADMIN');
    }
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível promover a SUPER_ADMIN');
    }

    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome.trim();
    const novoEmail = dto.email?.trim();
    if (novoEmail !== undefined && novoEmail !== target.email) {
      const emUso = await this.prisma.user.findUnique({ where: { email: novoEmail }, select: { id: true } });
      if (emUso) throw new ConflictException('Email já cadastrado');
      data.email = novoEmail;
    }
    if (dto.senha !== undefined) data.senha_hash = await bcrypt.hash(dto.senha, 12);
    if (dto.pl_sales_only !== undefined) data.pl_sales_only = dto.pl_sales_only;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.especialidade !== undefined) data.especialidade = dto.especialidade;
    if (dto.ativo !== undefined) data.ativo = dto.ativo;
    if (dto.sector_id !== undefined) {
      // null remove o membro do setor; string valida contra o tenant.
      data.sector_id = dto.sector_id
        ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
        : null;
    }

    const atualizado = await this.prisma.user.update({
      where: { id: targetId },
      data,
      select: TEAM_SELECT,
    });
    // Roda em TODO update, nao so quando `role` mudou: promocao
    // (VISUALIZADOR -> OPERADOR) e reativacao (`enable()` so clonou para quem
    // estava ATIVO) deixam o membro com papel de board e sem coluna nenhuma,
    // pelo mesmo motivo. Sem `dto.role`, o papel que vale e o atual.
    await this.garantirBoardDoMembro(caller.tenantId, targetId, dto.role ?? target.role);
    // Senha/email trocados pelo gestor derrubam as sessoes abertas: quem estava
    // logado com a credencial antiga nao pode seguir renovando o token.
    if (mexeCredenciais) await this.prisma.refreshToken.deleteMany({ where: { user_id: targetId } });
    if (mexeCredenciais || dto.pl_sales_only !== undefined || dto.role !== undefined || dto.ativo !== undefined) await this.refreshAccess(targetId);
    return atualizado;
  }

  /**
   * Credenciais (email/senha) e exclusao sao o caminho para tomar a conta de
   * alguem: gerente so mexe em quem esta abaixo dele; colega GERENTE so o
   * SUPER_ADMIN do tenant. A propria conta vai pelo Perfil (exige senha atual).
   */
  private assertCanManageCredentials(
    caller: AuthUser,
    target: { id: string; role: string; is_platform_admin: boolean },
  ) {
    if (target.id === caller.id) {
      throw new BadRequestException('Use a aba Perfil para alterar a sua própria conta.');
    }
    if (target.role === UserRole.SUPER_ADMIN || target.is_platform_admin) {
      throw new ForbiddenException('Não é possível alterar este usuário.');
    }
    if (target.role === UserRole.GERENTE && caller.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Somente o administrador pode alterar outro gerente.');
    }
  }

  /**
   * Exclui um membro da equipe. O historico fica: leads voltam ao escritorio
   * (mesma forma do returnToPool), mensagens e atividades perdem o autor,
   * tarefas passam para quem excluiu e o board pessoal e desmontado. Quem
   * carrega dado que nao pode perder o dono (numero de WhatsApp, producao de
   * parceiros) e barrado com o caminho a seguir — desativar continua valendo.
   */
  async deleteTeamMember(caller: AuthUser, targetId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
        tenant_id: true,
        is_platform_admin: true,
        _count: {
          select: {
            owned_tenants: true,
            owned_instances: true,
            sales_partners: true,
            partner_productions: true,
            partner_goals: true,
            partner_audits: true,
          },
        },
      },
    });
    if (!target || target.tenant_id !== caller.tenantId) throw new NotFoundException();
    this.assertCanManageCredentials(caller, target);
    const c = target._count;
    if (c.owned_tenants > 0) {
      throw new ConflictException('Este usuário é o dono do workspace e não pode ser excluído.');
    }
    if (c.owned_instances > 0) {
      throw new ConflictException('Este usuário é dono de instância(s) de WhatsApp. Remova ou transfira as instâncias antes de excluir.');
    }
    if (c.sales_partners + c.partner_productions + c.partner_goals + c.partner_audits > 0) {
      throw new ConflictException('Este usuário tem histórico de parceiros/produção. Desative-o em vez de excluir.');
    }

    const tenantId = caller.tenantId;
    let pipelinesAfetados: string[] = [];
    try {
      pipelinesAfetados = await this.prisma.$transaction(async (tx) => {
        // Boards a recarregar: os das colunas pessoais e os dos leads devolvidos.
        const [colunas, leads] = await Promise.all([
          tx.stage.findMany({
            where: { tenant_id: tenantId, user_id: targetId },
            select: { pipeline_id: true },
            distinct: ['pipeline_id'],
          }),
          tx.lead.findMany({
            where: { tenant_id: tenantId, responsavel_id: targetId },
            select: { pipeline_id: true },
            distinct: ['pipeline_id'],
          }),
        ]);
        await this.kanbanIndividual.removePersonalBoard(tx, tenantId, targetId);
        // Devolucao ao escritorio, com a forma do returnToPool: carimbo para
        // entrar na nuvem, privacidade liberada e corte de historico zerado.
        await tx.lead.updateMany({
          where: { tenant_id: tenantId, responsavel_id: targetId },
          data: { responsavel_id: null, assumed_at: null, is_private: false, returned_at: new Date() },
        });
        // Sem soltar a conversa, a proxima mensagem do cliente procuraria o
        // dono que nao existe mais.
        await tx.conversation.updateMany({
          where: { tenant_id: tenantId, responsavel_id: targetId },
          data: { responsavel_id: null, assumed_at: null },
        });
        await tx.message.updateMany({ where: { sent_by_user_id: targetId }, data: { sent_by_user_id: null } });
        await tx.message.updateMany({ where: { visible_to_user_id: targetId }, data: { visible_to_user_id: null } });
        await tx.leadActivity.updateMany({ where: { user_id: targetId }, data: { user_id: null } });
        // Resposta rapida pessoal morre com o dono; a global e do tenant e fica.
        await tx.quickReply.deleteMany({ where: { user_id: targetId, is_global: false } });
        await tx.quickReply.updateMany({ where: { user_id: targetId }, data: { user_id: null } });
        await tx.task.updateMany({ where: { responsavel_id: targetId }, data: { responsavel_id: caller.id } });
        await tx.user.delete({ where: { id: targetId } });
        return [...new Set([...colunas, ...leads].map((p) => p.pipeline_id))];
      }, TX_OPTS);
    } catch (err) {
      // FK fora do schema (o banco tem drift): a transacao voltou inteira e
      // nada foi apagado. Desativar continua sendo o caminho.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        this.logger.warn(`exclusao de membro bloqueada por FK ${String(err.meta?.field_name ?? '')} user=${targetId}`);
        throw new ConflictException('Este usuário ainda tem registros vinculados. Desative-o em vez de excluir.');
      }
      throw err;
    }

    await this.cache?.delPattern(`leads:list:${tenantId}:*`);
    await this.refreshAccess(targetId);
    for (const pipelineId of pipelinesAfetados) {
      this.gateway?.emitPipelineStagesChanged(tenantId, pipelineId, targetId);
    }
    this.logger.warn(`membro excluido por ${caller.email}: ${target.nome} <${target.email}> (${targetId}) tenant=${tenantId}`);
    return { ok: true };
  }

  async changePassword(user: AuthUser, dto: { currentPassword: string; newPassword: string }) {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { senha_hash: true },
    });
    if (!row) throw new BadRequestException('Usuário não encontrado');
    const ok = await bcrypt.compare(dto.currentPassword, row.senha_hash);
    if (!ok) throw new BadRequestException('Senha atual incorreta');
    const senha_hash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { senha_hash } });
    return { ok: true };
  }

  async updateProfile(
    user: AuthUser,
    dto: { nome?: string; titulo?: string | null; especialidade?: string | null; focus_mode?: boolean },
  ) {
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.especialidade !== undefined) data.especialidade = dto.especialidade;
    if (dto.focus_mode !== undefined) data.focus_mode = dto.focus_mode;
    return this.prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, nome: true, email: true, role: true, avatar_url: true, titulo: true, especialidade: true, focus_mode: true },
    });
  }

  async uploadAvatar(user: AuthUser, file: Express.Multer.File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('Apenas jpg, png ou webp são permitidos');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Tamanho máximo: 5MB');
    }
    const ext = file.mimetype.split('/')[1];
    const path = `avatars/${user.tenantId}/${user.id}.${ext}`;
    await this.media.upload(path, file.buffer, file.mimetype);
    const url = await this.media.getSignedUrl(path, 60 * 60 * 24 * 365);
    await this.prisma.user.update({ where: { id: user.id }, data: { avatar_url: url } });
    return { url };
  }

  findAllForTenant(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId, ativo: true, ...(isPlSalesOnly(user) ? {id:user.id} : {}) },
      select: { id: true, nome: true, email: true, role: true },
      orderBy: { nome: 'asc' },
    });
  }
}
