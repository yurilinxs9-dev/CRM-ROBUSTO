import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

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
  ) {}

  async isOn(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { kanban_individual: true },
    });
    return t?.kanban_individual === true;
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

    for (const s of base) {
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
      const pessoais = await tx.stage.findMany({
        where: { tenant_id: tenantId, user_id: { not: null } },
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
          where: { stage_id: { in: pessoais.map((p) => p.id) } },
          data: { stage_id: null },
        });
      }

      await tx.stage.deleteMany({ where: { tenant_id: tenantId, user_id: { not: null } } });
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
    if (!(await this.isOn(tenantId))) return fromStageId;
    return this.traduzir(tenantId, fromStageId, ownerId);
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

    const alvo = { tenant_id: tenantId, user_id: destinoUserId, pipeline_id: from.pipeline_id };

    const mesmoNome = await this.prisma.stage.findFirst({
      where: { ...alvo, nome: { equals: from.nome, mode: 'insensitive' } },
    });
    if (mesmoNome) return mesmoNome.id;

    const primeira = await this.prisma.stage.findFirst({
      where: alvo,
      orderBy: { ordem: 'asc' },
    });
    return primeira?.id ?? fromStageId;
  }

  private assertGestor(user: AuthUser): void {
    const ehGestor = user.role === UserRole.GERENTE || user.role === UserRole.SUPER_ADMIN;
    if (!ehGestor) {
      throw new ForbiddenException('Apenas gerente ou super admin altera o modo do kanban');
    }
  }
}
