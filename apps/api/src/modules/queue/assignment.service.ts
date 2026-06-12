import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Resultado de uma tentativa de atribuição round-robin. */
export interface AssignmentResult {
  /** Usuário escolhido, ou null se o setor não tem agentes ativos (espera). */
  userId: string | null;
  sectorId: string;
  reason: 'round_robin' | 'waiting_no_agents';
}

/**
 * F-02 — Distribuição round-robin por setor.
 *
 * O ponteiro (QueuePointer) é persistido em banco: restart do servidor não
 * perde a posição da fila. A seleção roda dentro de uma transação com
 * `SELECT ... FOR UPDATE` na linha do ponteiro — dois leads chegando ao mesmo
 * tempo são serializados pelo lock, sem atribuição duplicada.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve o setor de destino de um lead que entra por uma instância.
   * Usa o setor configurado na instância; se ausente/inativo, cai no setor
   * padrão "Sem Setor" do tenant (criado sob demanda — cobre tenants novos).
   */
  async resolveSectorForInstance(
    tenantId: string,
    instanceSectorId: string | null,
  ): Promise<string> {
    if (instanceSectorId) {
      const active = await this.prisma.sector.findFirst({
        where: { id: instanceSectorId, tenant_id: tenantId, active: true },
        select: { id: true },
      });
      if (active) return active.id;
    }
    return this.getOrCreateDefaultSector(tenantId);
  }

  /** Setor "Sem Setor" do tenant, criando se não existir (idempotente). */
  async getOrCreateDefaultSector(tenantId: string): Promise<string> {
    const existing = await this.prisma.sector.findUnique({
      where: { tenant_id_name: { tenant_id: tenantId, name: 'Sem Setor' } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.sector.create({
      data: { tenant_id: tenantId, name: 'Sem Setor' },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Escolhe o próximo agente do setor em rodízio e avança o ponteiro.
   * Atômico: lock na linha do ponteiro dentro da transação.
   *
   * @param tx  Transação externa (a do upsert do lead, p/ atribuição atômica).
   *            Se omitida, abre uma própria.
   */
  async assignBySector(
    tenantId: string,
    sectorId: string,
    leadId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AssignmentResult> {
    if (tx) return this.runAssign(tx, tenantId, sectorId, leadId);
    return this.prisma.$transaction((t) => this.runAssign(t, tenantId, sectorId, leadId));
  }

  private async runAssign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sectorId: string,
    leadId: string,
  ): Promise<AssignmentResult> {
    // Garante a linha do ponteiro e a trava (FOR UPDATE serializa concorrentes).
    await tx.$executeRaw`
      INSERT INTO "QueuePointer" ("sector_id", "current_index", "updated_at")
      VALUES (${sectorId}, 0, now())
      ON CONFLICT ("sector_id") DO NOTHING
    `;
    const locked = await tx.$queryRaw<{ current_index: number }[]>`
      SELECT "current_index" FROM "QueuePointer" WHERE "sector_id" = ${sectorId} FOR UPDATE
    `;
    const current = locked[0]?.current_index ?? 0;

    // Agentes elegíveis: ativos do setor, exceto VISUALIZADOR (read-only).
    // Ordenados por id → ordem estável (garante o padrão A,B,A,B).
    const agents = await tx.user.findMany({
      where: {
        tenant_id: tenantId,
        sector_id: sectorId,
        ativo: true,
        role: { not: 'VISUALIZADOR' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    if (agents.length === 0) {
      await tx.assignmentLog.create({
        data: { tenant_id: tenantId, sector_id: sectorId, lead_id: leadId, user_id: null, reason: 'waiting_no_agents' },
      });
      this.logger.warn(`Setor ${sectorId} sem agentes ativos — lead ${leadId} em espera`);
      return { userId: null, sectorId, reason: 'waiting_no_agents' };
    }

    // Inativação durante o rodízio encolhe a lista; o módulo garante landing
    // num agente ativo. Avança o ponteiro relativo ao tamanho atual.
    const idx = current % agents.length;
    const chosen = agents[idx].id;
    const next = (current + 1) % agents.length;

    await tx.$executeRaw`
      UPDATE "QueuePointer" SET "current_index" = ${next}, "updated_at" = now()
      WHERE "sector_id" = ${sectorId}
    `;
    await tx.assignmentLog.create({
      data: { tenant_id: tenantId, sector_id: sectorId, lead_id: leadId, user_id: chosen, reason: 'round_robin' },
    });

    return { userId: chosen, sectorId, reason: 'round_robin' };
  }
}
