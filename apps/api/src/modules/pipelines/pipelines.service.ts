import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { MessagesService } from '../messages/messages.service';
import {
  KanbanIndividualService,
  PAPEIS_COM_BOARD,
  TX_OPTS,
  temBoardProprio,
} from './kanban-individual.service';
import type { AuthUser } from '../../common/types/auth-user';
import { z } from 'zod';

const createPipelineSchema = z.object({
  nome: z.string().min(1).max(100),
  descricao: z.string().max(500).optional().nullable(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icone: z.string().max(50).optional().nullable(),
});

const updatePipelineSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  descricao: z.string().max(500).optional().nullable(),
  ativo: z.boolean().optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icone: z.string().max(50).optional().nullable(),
});

const createStageSchema = z.object({
  nome: z.string().min(1).max(100),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3498DB'),
  ordem: z.number().int().optional(),
  // Kanban individual: onde a coluna nasce. `own` (default) = board de quem
  // pede; `base` = modelo do tenant, so gestor. Sem o toggle e ignorado.
  scope: z.enum(['own', 'base']).optional(),
  sla_config: z.any().optional(),
  idle_alert_config: z.any().optional(),
  response_alert_config: z.any().optional(),
  on_entry_config: z.any().optional(),
  cadence_config: z.any().optional(),
});

const updateStageSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  ordem: z.number().int().optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  max_dias: z.number().int().positive().nullable().optional(),
  // Chance de fechar, em %, usada pela previsao ponderada do dashboard.
  // `null` = volta ao default por posicao entre as etapas abertas.
  probabilidade: z.number().int().min(0).max(100).nullable().optional(),
  auto_action: z.unknown().optional(),
  sla_config: z.any().optional(),
  idle_alert_config: z.any().optional(),
  response_alert_config: z.any().optional(),
  on_entry_config: z.any().optional(),
  cadence_config: z.any().optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1),
});

/** Campos do PATCH de etapa que um OPERADOR pode alterar (dia a dia). */
const CAMPOS_STAGE_OPERADOR = new Set(['nome', 'cor']);

const reorderPipelinesSchema = z.object({
  pipelineIds: z.array(z.string().uuid()).min(1),
});

const deleteWithMoveSchema = z.object({
  targetPipelineId: z.string().uuid(),
});

const deleteStageWithMoveSchema = z.object({
  targetStageId: z.string().uuid(),
});

/**
 * Escopo de leitura das etapas quando o kanban individual esta ligado.
 * `own` (default) = o board de quem pede (ou o de `view_as_user_id`, so gestor);
 * `base` = o modelo do tenant (colunas com user_id null), tambem so gestor.
 */
export const stageScopeQuerySchema = z.object({
  view_as_user_id: z.string().uuid().optional(),
  stage_scope: z.enum(['own', 'base']).optional(),
});

export type StageScopeOpts = {
  viewAsUserId?: string;
  stageScope?: 'own' | 'base';
};

@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);

  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
    private messages: MessagesService,
    private kanbanIndividual: KanbanIndividualService,
  ) {}

  private async invalidateLeadsCache(tenantId: string): Promise<void> {
    await this.cache.delPattern(`leads:list:${tenantId}:*`);
  }

  /**
   * Traduz quem pede + o que pediu no filtro de `Stage.user_id`. Com o toggle
   * desligado nao existe coluna pessoal: todo mundo continua lendo a base, que
   * e exatamente o comportamento anterior a esta feature.
   */
  private async stageScopeWhere(
    user: AuthUser,
    opts?: StageScopeOpts,
  ): Promise<Prisma.StageWhereInput> {
    const on = await this.kanbanIndividual.isOn(user.tenantId);
    if (!on) return { user_id: null };
    if (opts?.stageScope === 'base') {
      if (!this.ehGestor(user)) throw new ForbiddenException('Apenas gestores editam o modelo base.');
      return { user_id: null };
    }
    if (opts?.viewAsUserId && opts.viewAsUserId !== user.id) {
      if (!this.ehGestor(user)) throw new ForbiddenException('Apenas gestores usam Ver como.');
      return { user_id: opts.viewAsUserId };
    }
    // Papel sem board proprio (VISUALIZADOR) le o MODELO do tenant: o enable()
    // so clona a base para PAPEIS_COM_BOARD, entao `{ user_id: <id dele> }` nao
    // casaria com coluna nenhuma e o board abriria vazio para sempre — sem erro
    // nenhum que denunciasse o motivo. Mesma lista do clone, de proposito.
    if (!temBoardProprio(user.role)) return { user_id: null };
    return { user_id: user.id };
  }

  private ehGestor(user: AuthUser): boolean {
    return user.role === 'GERENTE' || user.role === 'SUPER_ADMIN';
  }

  /**
   * Porteiro unico das escritas de etapa com o kanban individual ligado:
   * a base (user_id null) e do gestor; o board pessoal e so do dono — nem o
   * gestor edita a coluna de um membro, senao "pessoal" nao quer dizer nada.
   * So faz sentido chamar com o toggle ON (com ele OFF nao existe coluna
   * pessoal e a regra antiga, por papel na rota, e a que vale).
   */
  private assertStageEditavel(stage: { user_id: string | null }, user: AuthUser): void {
    if (stage.user_id === null) {
      if (!this.ehGestor(user)) {
        throw new ForbiddenException('Apenas gestores editam o modelo base.');
      }
      return;
    }
    if (stage.user_id !== user.id) {
      throw new ForbiddenException('Coluna de outro membro');
    }
  }

  /**
   * Dono da etapa que esta nascendo. Com o toggle desligado nao existe coluna
   * pessoal: tudo continua na base, exatamente como antes da feature.
   */
  private async donoDaEtapaNova(user: AuthUser, scope?: 'own' | 'base'): Promise<string | null> {
    if (!(await this.kanbanIndividual.isOn(user.tenantId))) return null;
    if (scope === 'base') {
      if (!this.ehGestor(user)) {
        throw new ForbiddenException('Apenas gestores editam o modelo base.');
      }
      return null;
    }
    return user.id;
  }

  /**
   * Pipeline novo (ou duplicado) com o toggle ligado nasce so com a base; sem
   * clonar, o board de todo mundo ficaria vazio nesse funil. Roda na mesma
   * transacao da criacao — meio caminho aqui e pipeline invisivel para o time.
   */
  private async clonarBaseParaMembros(
    tx: Prisma.TransactionClient,
    tenantId: string,
    pipelineId: string,
  ): Promise<void> {
    const membros = await tx.user.findMany({
      where: { tenant_id: tenantId, ativo: true, role: { in: PAPEIS_COM_BOARD } },
      select: { id: true },
    });
    for (const membro of membros) {
      await this.kanbanIndividual.cloneBaseForUser(tx, tenantId, membro.id, pipelineId);
    }
    this.logger.log(
      `kanban individual: pipeline ${pipelineId} clonado para ${membros.length} membros`,
    );
  }

  async findAll(user: AuthUser, includeArchived = false, opts?: StageScopeOpts) {
    const stageWhere = await this.stageScopeWhere(user, opts);
    return this.prisma.pipeline.findMany({
      where: {
        ativo: true,
        tenant_id: user.tenantId,
        ...(includeArchived ? {} : { arquivado: false }),
      },
      include: {
        stages: { where: stageWhere, orderBy: { ordem: 'asc' } },
        _count: { select: { leads: true } },
      },
      orderBy: { ordem: 'asc' },
    });
  }

  async findOne(id: string, user: AuthUser, opts?: StageScopeOpts) {
    const stageWhere = await this.stageScopeWhere(user, opts);
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: {
        stages: {
          where: stageWhere,
          orderBy: { ordem: 'asc' },
          include: { _count: { select: { leads: true } } },
        },
      },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');
    return pipeline;
  }

  async create(body: unknown, user: AuthUser) {
    const data = createPipelineSchema.parse(body);
    const individual = await this.kanbanIndividual.isOn(user.tenantId);
    const count = await this.prisma.pipeline.count({ where: { tenant_id: user.tenantId } });
    return this.prisma.$transaction(async (tx) => {
      const pipeline = await tx.pipeline.create({
        data: {
          nome: data.nome,
          descricao: data.descricao ?? null,
          cor: data.cor ?? '#3b82f6',
          icone: data.icone ?? null,
          ordem: count,
          tenant_id: user.tenantId,
          stages: {
            create: [
              { nome: 'Novo Lead', cor: '#3498DB', ordem: 0, tenant_id: user.tenantId },
              { nome: 'Em Negociacao', cor: '#F39C12', ordem: 1, tenant_id: user.tenantId },
              { nome: 'Fechado', cor: '#27AE60', ordem: 2, is_won: true, tenant_id: user.tenantId },
            ],
          },
        },
        // As stages do retorno sao as base — os clones nascem depois e nao
        // interessam a quem acabou de criar o funil (gestor, na tela de ajustes).
        include: { stages: { orderBy: { ordem: 'asc' } } },
      });
      if (individual) await this.clonarBaseParaMembros(tx, user.tenantId, pipeline.id);
      return pipeline;
    }, TX_OPTS);
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = updatePipelineSchema.parse(body);
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data,
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
  }

  async remove(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    const leadsCount = await this.prisma.lead.count({
      where: { pipeline_id: id, tenant_id: user.tenantId },
    });
    if (leadsCount > 0) {
      throw new ConflictException('Nao e possivel excluir: existem leads neste pipeline');
    }
    await this.prisma.pipeline.update({ where: { id }, data: { ativo: false } });
    return { success: true };
  }

  async duplicate(id: string, user: AuthUser) {
    const individual = await this.kanbanIndividual.isOn(user.tenantId);
    const src = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: {
        // Com o toggle ligado o pipeline carrega tambem as colunas pessoais de
        // cada membro; copiar tudo faria a copia nascer com o board do time
        // inteiro achatado na base. So o modelo base e duplicado.
        stages: { where: individual ? { user_id: null } : {}, orderBy: { ordem: 'asc' } },
      },
    });
    if (!src) throw new NotFoundException('Pipeline nao encontrado');

    const baseName = `${src.nome} (copia)`;
    let finalName = baseName;
    let attempt = 1;
    while (
      await this.prisma.pipeline.findFirst({
        where: { tenant_id: user.tenantId, nome: finalName },
        select: { id: true },
      })
    ) {
      attempt += 1;
      finalName = `${baseName} ${attempt}`;
    }

    const count = await this.prisma.pipeline.count({ where: { tenant_id: user.tenantId } });
    return this.prisma.$transaction(async (tx) => {
      const copia = await tx.pipeline.create({
        data: {
          nome: finalName,
          descricao: src.descricao,
          cor: src.cor,
          icone: src.icone,
          ordem: count,
          tenant_id: user.tenantId,
          stages: {
            create: src.stages.map((s) => ({
              nome: s.nome,
              cor: s.cor,
              ordem: s.ordem,
              is_won: s.is_won,
              is_lost: s.is_lost,
              max_dias: s.max_dias,
              auto_action: (s.auto_action ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
              campos_obrigatorios: (s.campos_obrigatorios ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
              tenant_id: user.tenantId,
            })),
          },
        },
        include: { stages: { orderBy: { ordem: 'asc' } } },
      });
      if (individual) await this.clonarBaseParaMembros(tx, user.tenantId, copia.id);
      return copia;
    }, TX_OPTS);
  }

  async archive(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data: { arquivado: true },
    });
  }

  async unarchive(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data: { arquivado: false },
    });
  }

  async deleteWithMoveLeads(id: string, body: unknown, user: AuthUser) {
    const { targetPipelineId } = deleteWithMoveSchema.parse(body);
    if (targetPipelineId === id) {
      throw new BadRequestException('Pipeline de destino deve ser diferente do pipeline a excluir');
    }

    const [source, target] = await Promise.all([
      this.prisma.pipeline.findFirst({
        where: { id, tenant_id: user.tenantId },
        select: { id: true },
      }),
      this.prisma.pipeline.findFirst({
        where: { id: targetPipelineId, tenant_id: user.tenantId },
        // `user_id: null` recorta o MODELO BASE: com o kanban individual ligado,
        // sem isto a primeira etapa do destino podia ser a coluna pessoal de um
        // membro qualquer (mesma `ordem`, desempate indefinido) e o pipeline
        // inteiro cairia dentro do board de quem nem foi consultado. A base é o
        // ponto de partida certo — a coluna de cada dono sai da tradução abaixo.
        include: {
          stages: { where: { user_id: null }, orderBy: { ordem: 'asc' }, select: { id: true } },
        },
      }),
    ]);
    if (!source) throw new NotFoundException('Pipeline de origem nao encontrado');
    if (!target) throw new NotFoundException('Pipeline de destino nao encontrado');
    if (target.stages.length === 0) {
      throw new BadRequestException('Pipeline de destino nao possui etapas');
    }

    const targetFirstStageId = target.stages[0].id;
    const individual = await this.kanbanIndividual.isOn(user.tenantId);

    await this.prisma.$transaction(async (tx) => {
      /**
       * Kanban individual: os leads que atravessam de pipeline têm donos
       * DIVERSOS, e cada um enxerga a própria cópia das colunas. Jogar todo
       * mundo na primeira coluna base deixaria a etapa gravada fora do board do
       * dono (o card seria realocado na tela, mas SLA, cadência e segmento de
       * follow-up leem o `estagio_id`). Traduz por DONO, como o `bulkMoveStage`:
       * uma tradução por dono, não uma por lead.
       */
      if (individual) {
        const leads = await tx.lead.findMany({
          where: { pipeline_id: id, tenant_id: user.tenantId },
          select: { id: true, responsavel_id: true },
        });
        const porDono = new Map<string | null, string[]>();
        for (const lead of leads) {
          const doGrupo = porDono.get(lead.responsavel_id);
          if (doGrupo) doGrupo.push(lead.id);
          else porDono.set(lead.responsavel_id, [lead.id]);
        }
        for (const [dono, leadIds] of porDono) {
          const destino =
            dono === null
              ? await this.kanbanIndividual.stageForBase(user.tenantId, targetFirstStageId)
              : await this.kanbanIndividual.stageForOwner(
                  user.tenantId,
                  dono,
                  targetFirstStageId,
                );
          await tx.lead.updateMany({
            where: { id: { in: leadIds }, tenant_id: user.tenantId },
            data: { pipeline_id: targetPipelineId, estagio_id: destino },
          });
        }
      }

      // Toggle desligado: é a única escrita, exatamente como antes da feature.
      // Ligado: rede para o lead que tenha nascido no pipeline entre a leitura
      // acima e agora — sobrar apontando para a etapa de um pipeline arquivado
      // seria pior que cair na primeira coluna base.
      await tx.lead.updateMany({
        where: { pipeline_id: id, tenant_id: user.tenantId },
        data: { pipeline_id: targetPipelineId, estagio_id: targetFirstStageId },
      });
      await tx.pipeline.update({
        where: { id },
        data: { ativo: false, arquivado: true },
      });
    });

    await this.invalidateLeadsCache(user.tenantId);
    return { success: true, movedTo: targetPipelineId };
  }

  async reorderPipelines(body: unknown, user: AuthUser) {
    const { pipelineIds } = reorderPipelinesSchema.parse(body);
    const pipelines = await this.prisma.pipeline.findMany({
      where: { tenant_id: user.tenantId },
      select: { id: true },
    });
    const existing = new Set(pipelines.map((p) => p.id));
    if (!pipelineIds.every((pid) => existing.has(pid))) {
      throw new BadRequestException('pipelineIds invalidos para este tenant');
    }
    await this.prisma.$transaction(
      pipelineIds.map((pid, idx) =>
        this.prisma.pipeline.update({ where: { id: pid }, data: { ordem: idx } }),
      ),
    );
    return { success: true };
  }

  async createStage(pipelineId: string, body: unknown, user: AuthUser) {
    const data = createStageSchema.parse(body);
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipelineId, tenant_id: user.tenantId },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');
    const dono = await this.donoDaEtapaNova(user, data.scope);
    // A ordem e por escopo: a coluna nova entra no fim do board dela, nao no
    // fim da soma de todos os boards do pipeline.
    const last = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipelineId, tenant_id: user.tenantId, user_id: dono },
      orderBy: { ordem: 'desc' },
    });
    const ordem = data.ordem ?? (last ? last.ordem + 1 : 0);
    return this.prisma.stage.create({
      data: {
        nome: data.nome,
        cor: data.cor,
        ordem,
        pipeline_id: pipelineId,
        tenant_id: user.tenantId,
        user_id: dono,
      },
    });
  }

  async updateStage(id: string, body: unknown, user: AuthUser) {
    const data = updateStageSchema.parse(body);
    // A rota e liberada para OPERADOR (dia a dia: renomear/cor), mas o mesmo
    // PATCH carrega campos estruturais (ganho/perda, automacoes, SLA/cadencia,
    // probabilidade). Guarda fina: operador so passa com nome/cor no payload.
    if (!this.ehGestor(user)) {
      const estruturais = Object.keys(data).filter(
        (chave) => !CAMPOS_STAGE_OPERADOR.has(chave),
      );
      if (estruturais.length > 0) {
        throw new ForbiddenException(
          'Permissao insuficiente: apenas gerentes alteram automacoes e campos estruturais da etapa.',
        );
      }
    }
    const exists = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Stage nao encontrada');
    if (await this.kanbanIndividual.isOn(user.tenantId)) {
      this.assertStageEditavel(exists, user);
    }
    const { auto_action, ...rest } = data;
    const updateData: Prisma.StageUpdateInput = { ...rest };
    if (auto_action !== undefined) {
      updateData.auto_action =
        auto_action === null
          ? Prisma.JsonNull
          : (auto_action as Prisma.InputJsonValue);
    }
    return this.prisma.stage.update({ where: { id }, data: updateData });
  }

  async removeStage(id: string, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Stage nao encontrada');
    if (await this.kanbanIndividual.isOn(user.tenantId)) {
      this.assertStageEditavel(stage, user);
    }
    const leadsCount = await this.prisma.lead.count({
      where: { estagio_id: id, tenant_id: user.tenantId },
    });
    if (leadsCount > 0) {
      throw new ConflictException(
        'Nao e possivel excluir: existem leads nesta stage. Mova-os antes de excluir.',
      );
    }
    await this.prisma.stage.delete({ where: { id } });
    return { success: true };
  }

  async removeStageWithMove(id: string, body: unknown, user: AuthUser) {
    const { targetStageId } = deleteStageWithMoveSchema.parse(body);
    if (targetStageId === id) {
      throw new BadRequestException('Etapa de destino deve ser diferente da etapa a excluir');
    }
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Stage nao encontrada');
    const individual = await this.kanbanIndividual.isOn(user.tenantId);
    if (individual) this.assertStageEditavel(stage, user);
    const target = await this.prisma.stage.findFirst({
      where: { id: targetStageId, tenant_id: user.tenantId, pipeline_id: stage.pipeline_id },
      select: { id: true, user_id: true },
    });
    if (!target) {
      throw new NotFoundException('Etapa de destino nao encontrada no mesmo pipeline');
    }
    // Mover leads para a coluna de outro board mudaria de dono a carteira
    // inteira sem ninguem pedir — a mudanca de dono e das rotas de lead.
    if (individual && target.user_id !== stage.user_id) {
      throw new BadRequestException('Etapa de destino pertence a outro board');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({
        where: { estagio_id: id, tenant_id: user.tenantId },
        data: { estagio_id: targetStageId, estagio_entered_at: new Date() },
      });
      await tx.stage.delete({ where: { id } });
    });

    await this.invalidateLeadsCache(user.tenantId);
    return { success: true, movedTo: targetStageId };
  }

  /**
   * Reorder e a unica escrita que chega com um conjunto de etapas de uma vez:
   * com o toggle ligado o conjunto tem que ser de um dono so, e desse dono quem
   * pede precisa poder editar. Devolve o filtro de dono que valida a lista.
   */
  private async escopoDeReorder(
    pipelineId: string,
    stageIds: string[],
    user: AuthUser,
  ): Promise<Prisma.StageWhereInput> {
    if (!(await this.kanbanIndividual.isOn(user.tenantId))) return {};
    const alvo = await this.prisma.stage.findMany({
      where: { id: { in: stageIds }, tenant_id: user.tenantId, pipeline_id: pipelineId },
      select: { id: true, user_id: true },
    });
    if (alvo.length !== stageIds.length) {
      throw new BadRequestException('stageIds invalidos para este pipeline');
    }
    const donos = new Set(alvo.map((s) => s.user_id));
    if (donos.size > 1) {
      throw new BadRequestException('stageIds misturam o modelo base e boards pessoais');
    }
    const dono = alvo[0].user_id;
    this.assertStageEditavel({ user_id: dono }, user);
    return { user_id: dono };
  }

  async reorderStages(pipelineId: string, body: unknown, user: AuthUser) {
    const { stageIds } = reorderStagesSchema.parse(body);
    const escopo = await this.escopoDeReorder(pipelineId, stageIds, user);
    const stages = await this.prisma.stage.findMany({
      where: { pipeline_id: pipelineId, tenant_id: user.tenantId, ...escopo },
      select: { id: true },
    });
    const existing = new Set(stages.map((s) => s.id));
    if (stageIds.length !== stages.length || !stageIds.every((id) => existing.has(id))) {
      throw new BadRequestException('stageIds invalidos para este pipeline');
    }
    await this.prisma.$transaction(
      stageIds.map((id, idx) =>
        this.prisma.stage.update({ where: { id }, data: { ordem: idx } }),
      ),
    );
    return { success: true };
  }

  async cadenceEligibleCount(stageId: string, stepIndex: number, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: stageId, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada');

    const config = stage.cadence_config as any;
    const steps: any[] = config?.steps ?? [];
    const step = steps[stepIndex];
    if (!step) return { count: 0 };

    const now = new Date();
    const thresholdMs =
      step.unit === 'MINUTES' ? step.duration * 60_000 :
      step.unit === 'HOURS'   ? step.duration * 3_600_000 :
      /* DAYS */                step.duration * 86_400_000;
    const cutoff = new Date(now.getTime() - thresholdMs);

    const count = await this.prisma.lead.count({
      where: {
        estagio_id: stageId,
        tenant_id: user.tenantId,
        cadence_step_index: stepIndex,
        estagio_entered_at: { lte: cutoff },
      },
    });

    return { count };
  }

  async fireCadenceStep(
    stageId: string,
    stepIndex: number,
    user: AuthUser,
    opts: { batchSize?: number; delayMinSec?: number; delayMaxSec?: number } = {},
  ) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: stageId, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada');

    const config = stage.cadence_config as any;
    const steps: any[] = config?.steps ?? [];
    const step = steps[stepIndex];
    if (!step) throw new BadRequestException('Passo de cadência não existe');
    if (!step.template) throw new BadRequestException('Passo sem mensagem definida');

    const now = new Date();
    const thresholdMs =
      step.unit === 'MINUTES' ? step.duration * 60_000 :
      step.unit === 'HOURS'   ? step.duration * 3_600_000 :
      /* DAYS */                step.duration * 86_400_000;
    const cutoff = new Date(now.getTime() - thresholdMs);

    const where: any = {
      estagio_id: stageId,
      tenant_id: user.tenantId,
      cadence_step_index: stepIndex,
      estagio_entered_at: { lte: cutoff },
    };

    // Trava Anti-Robô (manual): só dispara se cliente está sem responder há X tempo
    const lock = step.safety_lock;
    if (lock?.enabled) {
      const lockMs =
        lock.unit === 'MINUTES' ? lock.duration * 60_000 :
        lock.unit === 'HOURS'   ? lock.duration * 3_600_000 :
        /* DAYS */                lock.duration * 86_400_000;
      const lockCutoff = new Date(now.getTime() - lockMs);
      where.OR = [
        { last_customer_message_at: null },
        { last_customer_message_at: { lte: lockCutoff } },
      ];
    }

    const all = await this.prisma.lead.findMany({
      where,
      select: { id: true },
      orderBy: { estagio_entered_at: 'asc' },
    });

    const batch = opts.batchSize && opts.batchSize > 0 ? all.slice(0, opts.batchSize) : all;
    const delayMin = Math.max(0, opts.delayMinSec ?? 0);
    const delayMax = Math.max(delayMin, opts.delayMaxSec ?? 0);

    this.logger.log(`fireCadenceStep: disparando ${batch.length}/${all.length} leads (step ${stepIndex}, delay ${delayMin}-${delayMax}s, user ${user.id})`);

    // Background loop — não bloqueia HTTP. Erros logados, próximos leads continuam.
    void (async () => {
      for (let i = 0; i < batch.length; i++) {
        const lead = batch[i];
        try {
          await this.messages.sendText({ lead_id: lead.id, content: step.template }, user);
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { cadence_step_index: stepIndex + 1, proximo_followup: null },
          });
          this.logger.debug(`fireCadenceStep: enviado para lead ${lead.id} (${i + 1}/${batch.length})`);
        } catch (err) {
          this.logger.error(`fireCadenceStep: erro no lead ${lead.id}: ${String(err)}`);
        }
        if (i < batch.length - 1 && delayMax > 0) {
          const waitMs = (delayMin + Math.random() * (delayMax - delayMin)) * 1000;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      this.logger.log(`fireCadenceStep: concluído ${batch.length} leads`);
    })();

    return { scheduled: batch.length, totalEligible: all.length };
  }
}
