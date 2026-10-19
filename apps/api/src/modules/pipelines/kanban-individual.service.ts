import { ConflictException, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { PL_PIPELINE, PL_TENANT } from '../pl-sales/pl-sales.domain';
import { RedisCacheService } from '../../common/cache/redis-cache.service';

/**
 * Kanban individual: com o toggle ligado cada membro operacional enxerga uma
 * copia das colunas base do tenant (Stage.user_id = membro) e os leads sob sua
 * responsabilidade vivem na copia dele. As colunas base (user_id = null) viram
 * o "modelo" do tenant — continuam existindo, guardando os leads sem dono.
 *
 * Este service e o unico dono das duas travessias perigosas (ligar/desligar) e
 * das duas traducoes de coluna que as rotas de lead precisam consultar. Nao
 * importa nenhum outro modulo de dominio de proposito: as Tasks 3-6 consomem
 * ele de dentro de pipelines/leads/broadcasts e um import cruzado viraria ciclo.
 */

/**
 * Papeis que ganham board proprio. VISUALIZADOR nao move lead, entao nao clona.
 * Exportado porque o PipelinesService clona a base para os mesmos membros
 * quando nasce um pipeline novo — duas listas divergiriam em silencio.
 */
export const PAPEIS_COM_BOARD: UserRole[] = [
  UserRole.OPERADOR,
  UserRole.GERENTE,
  UserRole.SUPER_ADMIN,
];

/**
 * O papel ganha copia das colunas? Existe para as rotas perguntarem sem cast:
 * `AuthUser.role` vem do enum do Prisma e `PAPEIS_COM_BOARD` do enum local, que
 * o TypeScript nao considera o mesmo tipo. Quem NAO tem board le a BASE — e
 * essa e a unica leitura correta, porque o enable() nunca clonou nada para ele.
 */
export function temBoardProprio(role: string): boolean {
  return (PAPEIS_COM_BOARD as string[]).includes(role);
}

/**
 * Ligar/desligar e O(membros x colunas) em round-trips dentro de UMA transacao.
 * O default do Prisma (5s de timeout) estoura com tenant grande e devolve P2028
 * no meio do remapeamento, entao os dois toggles pedem janela larga. Criar
 * pipeline com o toggle ligado tem a mesma forma, entao reusa a mesma janela.
 */
export const TX_OPTS = { timeout: 120_000, maxWait: 10_000 } as const;

/** Colunas sao comparadas por nome normalizado — o clone nasce com o nome da base. */
function normalizar(nome: string): string {
  return nome.toLowerCase().trim();
}

function chave(pipelineId: string, nome: string): string {
  return `${pipelineId}::${normalizar(nome)}`;
}

@Injectable()
export class KanbanIndividualService {
  private readonly logger = new Logger(KanbanIndividualService.name);

  /**
   * O CrmGateway entra por DI direta (WebSocketModule e @Global) — nao e modulo
   * de dominio, entao a lista de imports vazia deste modulo continua valendo e
   * nenhum ciclo nasce daqui.
   */
  constructor(
    private prisma: PrismaService,
    private gateway: CrmGateway,
    @Optional() private cache?: RedisCacheService,
  ) {}

  async isOn(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { kanban_individual: true },
    });
    return t?.kanban_individual === true;
  }

  /** PL private boards coexist with the shared workspace without changing its toggle. */
  async hasPersonalBoards(tenantId: string): Promise<boolean> {
    return tenantId === PL_TENANT || this.isOn(tenantId);
  }

  async usesPersonalBoard(tenantId: string, ownerId: string | null, pipelineId?: string): Promise<boolean> {
    if (!ownerId) return false;
    if (await this.isOn(tenantId)) return true;
    if (tenantId !== PL_TENANT || (pipelineId !== undefined && pipelineId !== PL_PIPELINE)) return false;
    return this.isPlOwner(tenantId, ownerId);
  }

  private async isPlOwner(tenantId: string, ownerId: string): Promise<boolean> {
    if (tenantId !== PL_TENANT) return false;
    return !!(await this.prisma.user.findFirst({
      where: { id: ownerId, tenant_id: tenantId, role: 'OPERADOR', ativo: true, pl_sales_only: true },
      select: { id: true },
    }));
  }

  /** One transactional initialization, including any existing own PL portfolio. */
  async ensurePlPersonalBoard(tenantId: string, ownerId: string): Promise<void> {
    if (!(await this.isPlOwner(tenantId, ownerId))) return;
    const scope = { tenant_id: tenantId, pipeline_id: PL_PIPELINE, user_id: ownerId };
    if (await this.prisma.stage.findFirst({ where: scope, select: { id: true } })) return;
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pl-board:${tenantId}:${ownerId}`}))`;
      if (await tx.stage.findFirst({ where: scope, select: { id: true } })) return;
      const base = await tx.stage.findMany({
        where: { tenant_id: tenantId, pipeline_id: PL_PIPELINE, user_id: null },
        orderBy: { ordem: 'asc' },
      });
      if (!base.length) throw new ConflictException('O modelo do Consórcio PL ainda não tem etapas.');
      await this.cloneBaseForUser(tx, tenantId, ownerId, PL_PIPELINE);
      const own = await tx.stage.findMany({ where: scope });
      for (const source of base) {
        const target = own.find(s => s.nome === source.nome && s.ordem === source.ordem);
        if (!target) throw new ConflictException('Não foi possível preparar as etapas individuais.');
        await tx.lead.updateMany({
          where: { tenant_id: tenantId, pipeline_id: PL_PIPELINE, responsavel_id: ownerId, estagio_id: source.id },
          data: { estagio_id: target.id },
        });
      }
    }, TX_OPTS);
    await this.cache?.delPattern(`leads:list:${tenantId}:*`);
    this.gateway.emitPipelineStagesChanged?.(tenantId, PL_PIPELINE, ownerId);
  }

  /**
   * Clona o conjunto base do tenant (ou de um pipeline) para um membro,
   * carregando todos os campos de configuracao: SLA, cadencia e alertas
   * precisam continuar valendo no board pessoal.
   */
  async cloneBaseForUser(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    pipelineId?: string,
  ): Promise<void> {
    const base = await tx.stage.findMany({
      where: { tenant_id: tenantId, user_id: null, ...(pipelineId ? { pipeline_id: pipelineId } : {}) },
      orderBy: { ordem: 'asc' },
    });

    // Enabling the workspace-wide mode must not duplicate or reset a PL board.
    if (tenantId === PL_TENANT && base.some(s => s.pipeline_id === PL_PIPELINE)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pl-board:${tenantId}:${userId}`}))`;
    }
    const existingPl = tenantId === PL_TENANT && base.some(s => s.pipeline_id === PL_PIPELINE)
      ? await tx.stage.findFirst({ where: { tenant_id: tenantId, pipeline_id: PL_PIPELINE, user_id: userId }, select: { id: true } })
      : null;

    for (const s of base) {
      if (existingPl && s.pipeline_id === PL_PIPELINE) continue;
      await tx.stage.create({
        data: {
          nome: s.nome,
          cor: s.cor,
          ordem: s.ordem,
          pipeline_id: s.pipeline_id,
          tenant_id: tenantId,
          user_id: userId,
          is_won: s.is_won,
          is_lost: s.is_lost,
          max_dias: s.max_dias,
          probabilidade: s.probabilidade,
          auto_action: (s.auto_action ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          campos_obrigatorios: (s.campos_obrigatorios ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sla_config: (s.sla_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          idle_alert_config: (s.idle_alert_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          response_alert_config: (s.response_alert_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          on_entry_config: (s.on_entry_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          cadence_config: (s.cadence_config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    }
  }

  /**
   * Liga o toggle: clona a base para cada membro ativo e puxa os leads de cada
   * responsavel para a coluna equivalente dele. Lead sem responsavel fica na
   * base. Tudo numa transacao — meio caminho aqui e board furado.
   */
  async enable(user: AuthUser): Promise<{ success: true }> {
    this.assertGestor(user);
    const tenantId = user.tenantId;

    if (await this.isOn(tenantId)) {
      throw new ConflictException('Kanban individual ja esta ligado');
    }

    await this.prisma.$transaction(async (tx) => {
      const base = await tx.stage.findMany({
        where: { tenant_id: tenantId, user_id: null },
        orderBy: { ordem: 'asc' },
      });

      const membros = await tx.user.findMany({
        where: { tenant_id: tenantId, ativo: true, role: { in: PAPEIS_COM_BOARD } },
        select: { id: true },
      });

      for (const membro of membros) {
        await this.cloneBaseForUser(tx, tenantId, membro.id);

        const clones = await tx.stage.findMany({
          where: { tenant_id: tenantId, user_id: membro.id },
        });
        const porChave = new Map(clones.map((c) => [chave(c.pipeline_id, c.nome), c.id]));

        for (const b of base) {
          const destino = porChave.get(chave(b.pipeline_id, b.nome));
          if (!destino || destino === b.id) continue;
          await tx.lead.updateMany({
            where: { tenant_id: tenantId, responsavel_id: membro.id, estagio_id: b.id },
            data: { estagio_id: destino },
          });
        }
      }

      await tx.tenant.update({ where: { id: tenantId }, data: { kanban_individual: true } });

      this.logger.log(
        `kanban individual ON tenant=${tenantId} membros=${membros.length} colunas_base=${base.length}`,
      );
    }, TX_OPTS);

    // Board de todo mundo mudou de conjunto de colunas E de posicao dos cards:
    // sem o aviso, quem estava com a tela aberta segue arrastando card para
    // coluna que o backend nao reconhece mais como dele.
    this.gateway.emitKanbanIndividualChanged(tenantId, true);

    return { success: true };
  }

  /**
   * Desliga: devolve todo lead das colunas pessoais para a base de mesmo nome
   * (fallback: primeira base do mesmo pipeline), solta os Broadcasts que
   * segmentavam por coluna pessoal e so entao apaga as pessoais — Lead.estagio
   * e FK restrita, apagar antes de remapear derruba a transacao.
   */
  async disable(user: AuthUser): Promise<{ success: true }> {
    this.assertGestor(user);
    const tenantId = user.tenantId;

    if (!(await this.isOn(tenantId))) {
      throw new ConflictException('Kanban individual ja esta desligado');
    }

    await this.prisma.$transaction(async (tx) => {
      const base = await tx.stage.findMany({
        where: { tenant_id: tenantId, user_id: null },
        orderBy: { ordem: 'asc' },
      });
      const plOwners = tenantId === PL_TENANT ? await tx.user.findMany({
        where: { tenant_id: tenantId, role: 'OPERADOR', pl_sales_only: true }, select: { id: true },
      }) : [];
      const removable: Prisma.StageWhereInput = {
        tenant_id: tenantId, user_id: { not: null },
        ...(plOwners.length ? { NOT: { pipeline_id: PL_PIPELINE, user_id: { in: plOwners.map(u => u.id) } } } : {}),
      };
      const pessoais = await tx.stage.findMany({
        where: removable,
        orderBy: { ordem: 'asc' },
      });

      for (const p of pessoais) {
        const mesmoNome = base.find(
          (b) => b.pipeline_id === p.pipeline_id && normalizar(b.nome) === normalizar(p.nome),
        );
        const primeiraDoPipeline = base.find((b) => b.pipeline_id === p.pipeline_id);
        const destino = mesmoNome ?? primeiraDoPipeline ?? base[0];
        if (!destino) continue;

        // Pipeline sem nenhuma base: o lead atravessa de pipeline, entao o
        // pipeline_id dele tem que acompanhar a coluna nova.
        const mudaDePipeline = destino.pipeline_id !== p.pipeline_id;
        await tx.lead.updateMany({
          where: { tenant_id: tenantId, estagio_id: p.id },
          data: mudaDePipeline
            ? { estagio_id: destino.id, pipeline_id: destino.pipeline_id }
            : { estagio_id: destino.id },
        });
      }

      if (pessoais.length > 0) {
        await tx.broadcast.updateMany({
          // `tenant_id` e redundante com os ids (que ja sao deste tenant), mas
          // toda escrita do projeto carrega o recorte — um id vindo de outra
          // fonte um dia nao pode virar escrita cross-tenant por descuido.
          where: { tenant_id: tenantId, stage_id: { in: pessoais.map((p) => p.id) } },
          data: { stage_id: null },
        });
      }

      await tx.stage.deleteMany({ where: removable });
      await tx.tenant.update({ where: { id: tenantId }, data: { kanban_individual: false } });

      this.logger.log(`kanban individual OFF tenant=${tenantId} pessoais_removidas=${pessoais.length}`);
    }, TX_OPTS);

    // Idem do enable: as colunas pessoais acabaram de ser APAGADAS. Sem o
    // aviso, o board aberto fica apontando para etapas inexistentes.
    this.gateway.emitKanbanIndividualChanged(tenantId, false);

    return { success: true };
  }

  /**
   * Traduz uma coluna qualquer para a coluna equivalente do dono informado.
   * Com o toggle desligado nao existe coluna pessoal: devolve o id recebido.
   */
  async stageForOwner(tenantId: string, ownerId: string, fromStageId: string): Promise<string> {
    const global = await this.isOn(tenantId);
    if (tenantId !== PL_TENANT) return global ? this.traduzir(tenantId, fromStageId, ownerId) : fromStageId;
    const source = await this.prisma.stage.findFirst({ where: { id: fromStageId, tenant_id: tenantId }, select: { pipeline_id: true } });
    if (source?.pipeline_id !== PL_PIPELINE) return global ? this.traduzir(tenantId, fromStageId, ownerId) : fromStageId;
    const personal = await this.isPlOwner(tenantId, ownerId);
    if (personal) await this.ensurePlPersonalBoard(tenantId, ownerId);
    return this.traduzir(tenantId, fromStageId, global || personal ? ownerId : null);
  }

  /** Traduz uma coluna qualquer para a equivalente do conjunto base do tenant. */
  async stageForBase(tenantId: string, fromStageId: string): Promise<string> {
    return this.traduzir(tenantId, fromStageId, null);
  }

  private async traduzir(
    tenantId: string,
    fromStageId: string,
    destinoUserId: string | null,
  ): Promise<string> {
    const from = await this.prisma.stage.findFirst({
      where: { id: fromStageId, tenant_id: tenantId },
    });
    if (!from) return fromStageId;
    if (from.user_id === destinoUserId) return fromStageId;

    const isPl = tenantId === PL_TENANT && from.pipeline_id === PL_PIPELINE;
    const alvo = {
      tenant_id: tenantId, user_id: destinoUserId, pipeline_id: from.pipeline_id,
      ...(isPl ? { is_won: from.is_won, is_lost: from.is_lost } : {}),
    };

    const mesmoNome = await this.prisma.stage.findFirst({
      where: { ...alvo, nome: { equals: from.nome, mode: 'insensitive' } },
    });
    if (mesmoNome) return mesmoNome.id;

    const primeira = await this.prisma.stage.findFirst({
      where: alvo,
      orderBy: { ordem: 'asc' },
    });
    if (!primeira && isPl) throw new ConflictException('O destino não tem uma etapa compatível com a situação deste lead.');
    return primeira?.id ?? fromStageId;
  }

  private assertGestor(user: AuthUser): void {
    const ehGestor = user.role === UserRole.GERENTE || user.role === UserRole.SUPER_ADMIN;
    if (!ehGestor) {
      throw new ForbiddenException('Apenas gerente ou super admin altera o modo do kanban');
    }
  }
}
