import { Module } from '@nestjs/common';
import { KanbanIndividualService } from './kanban-individual.service';

/**
 * Modulo de proposito unico: so expoe o service. PrismaModule e @Global, entao
 * nao ha nada para importar — e e justamente essa lista de imports vazia que
 * garante que pipelines/leads/broadcasts possam depender dele sem ciclo.
 */
@Module({
  providers: [KanbanIndividualService],
  exports: [KanbanIndividualService],
})
export class KanbanIndividualModule {}
