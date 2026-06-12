import { Module } from '@nestjs/common';
import { AssignmentService } from './assignment.service';

/**
 * F-02 — Distribuição round-robin por setor. Sem controller próprio: o serviço
 * é consumido pelo webhook.processor (atribuição no lead que entra).
 */
@Module({
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class QueueModule {}
