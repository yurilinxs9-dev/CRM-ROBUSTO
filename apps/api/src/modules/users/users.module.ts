import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SectorsModule } from '../sectors/sectors.module';
import { KanbanIndividualModule } from '../pipelines/kanban-individual.module';

@Module({
  // KanbanIndividualModule: membro novo criado com o toggle ligado precisa
  // ganhar a copia das colunas base na hora (ver garantirBoardDoMembro). O
  // modulo nao importa ninguem, entao nao ha risco de ciclo.
  imports: [SectorsModule, KanbanIndividualModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
