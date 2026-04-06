import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { UserRole } from '@/common/types/roles';
import { z } from 'zod';
import { Prisma, TaskStatus, TaskType, Prioridade } from '@prisma/client';

const taskTypeEnum = z.nativeEnum(TaskType);
const taskStatusEnum = z.nativeEnum(TaskStatus);
const prioridadeEnum = z.nativeEnum(Prioridade);

const createTaskSchema = z.object({
  titulo: z.string().min(1),
  descricao: z.string().optional(),
  tipo: taskTypeEnum.default(TaskType.FOLLOW_UP),
  prioridade: prioridadeEnum.default(Prioridade.MEDIA),
  scheduled_at: z.string().datetime().or(z.date()),
  duracao_min: z.number().int().positive().optional(),
  lead_id: z.string().uuid().optional(),
});

const updateTaskSchema = z.object({
  titulo: z.string().min(1).optional(),
  descricao: z.string().nullable().optional(),
  tipo: taskTypeEnum.optional(),
  status: taskStatusEnum.optional(),
  prioridade: prioridadeEnum.optional(),
  scheduled_at: z.string().datetime().or(z.date()).optional(),
  duracao_min: z.number().int().positive().nullable().optional(),
  lead_id: z.string().uuid().nullable().optional(),
});

export interface AuthUser {
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  ativo: boolean;
}

export interface TaskFilters {
  from?: string;
  to?: string;
  status?: string;
  lead_id?: string;
  responsavel_id?: string;
}

const taskInclude = {
  lead: { select: { id: true, nome: true, telefone: true, foto_url: true } },
  responsavel: { select: { id: true, nome: true, avatar_url: true } },
} as const;

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private gateway: CrmGateway,
  ) {}

  private scopeWhere(user: AuthUser, where: Prisma.TaskWhereInput = {}): Prisma.TaskWhereInput {
    if (user.role === UserRole.OPERADOR) {
      return { ...where, responsavel_id: user.id };
    }
    return where;
  }

  async findAll(user: AuthUser, filters: TaskFilters) {
    const where: Prisma.TaskWhereInput = {};
    if (filters.from || filters.to) {
      where.scheduled_at = {};
      if (filters.from) (where.scheduled_at as Prisma.DateTimeFilter).gte = new Date(filters.from);
      if (filters.to) (where.scheduled_at as Prisma.DateTimeFilter).lte = new Date(filters.to);
    }
    if (filters.status) where.status = filters.status as TaskStatus;
    if (filters.lead_id) where.lead_id = filters.lead_id;
    if (filters.responsavel_id) where.responsavel_id = filters.responsavel_id;

    return this.prisma.task.findMany({
      where: this.scopeWhere(user, where),
      include: taskInclude,
      orderBy: { scheduled_at: 'asc' },
    });
  }

  async findToday(user: AuthUser) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return this.prisma.task.findMany({
      where: this.scopeWhere(user, {
        responsavel_id: user.id,
        scheduled_at: { gte: start, lte: end },
      }),
      include: taskInclude,
      orderBy: { scheduled_at: 'asc' },
    });
  }

  async findUpcoming(user: AuthUser) {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 7);
    return this.prisma.task.findMany({
      where: this.scopeWhere(user, {
        responsavel_id: user.id,
        scheduled_at: { gte: start, lte: end },
        status: { in: [TaskStatus.PENDENTE, TaskStatus.ATRASADA] },
      }),
      include: taskInclude,
      orderBy: { scheduled_at: 'asc' },
    });
  }

  async findOverdue(user: AuthUser) {
    return this.prisma.task.findMany({
      where: this.scopeWhere(user, {
        responsavel_id: user.id,
        status: TaskStatus.ATRASADA,
      }),
      include: taskInclude,
      orderBy: { scheduled_at: 'desc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: taskInclude,
    });
    if (!task) throw new NotFoundException('Tarefa nao encontrada');
    if (user.role === UserRole.OPERADOR && task.responsavel_id !== user.id) {
      throw new ForbiddenException();
    }
    return task;
  }

  async create(data: unknown, user: AuthUser) {
    const parsed = createTaskSchema.parse(data);
    const task = await this.prisma.task.create({
      data: {
        titulo: parsed.titulo,
        descricao: parsed.descricao,
        tipo: parsed.tipo,
        prioridade: parsed.prioridade,
        scheduled_at: new Date(parsed.scheduled_at),
        duracao_min: parsed.duracao_min,
        lead_id: parsed.lead_id,
        responsavel_id: user.id,
      },
      include: taskInclude,
    });
    this.gateway.emitTaskCreated(task.responsavel_id, task);
    return task;
  }

  async update(id: string, data: unknown, user: AuthUser) {
    const existing = await this.findOne(id, user);
    const parsed = updateTaskSchema.parse(data);
    const updateData: Prisma.TaskUpdateInput = {};
    if (parsed.titulo !== undefined) updateData.titulo = parsed.titulo;
    if (parsed.descricao !== undefined) updateData.descricao = parsed.descricao;
    if (parsed.tipo !== undefined) updateData.tipo = parsed.tipo;
    if (parsed.status !== undefined) updateData.status = parsed.status;
    if (parsed.prioridade !== undefined) updateData.prioridade = parsed.prioridade;
    if (parsed.scheduled_at !== undefined) updateData.scheduled_at = new Date(parsed.scheduled_at);
    if (parsed.duracao_min !== undefined) updateData.duracao_min = parsed.duracao_min;
    if (parsed.lead_id !== undefined) {
      updateData.lead = parsed.lead_id
        ? { connect: { id: parsed.lead_id } }
        : { disconnect: true };
    }
    const task = await this.prisma.task.update({
      where: { id },
      data: updateData,
      include: taskInclude,
    });
    this.gateway.emitTaskUpdated(existing.responsavel_id, task);
    return task;
  }

  async remove(id: string, user: AuthUser) {
    await this.findOne(id, user);
    await this.prisma.task.delete({ where: { id } });
    return { ok: true };
  }

  async complete(id: string, user: AuthUser) {
    await this.findOne(id, user);
    const task = await this.prisma.task.update({
      where: { id },
      data: { status: TaskStatus.CONCLUIDA, completed_at: new Date() },
      include: taskInclude,
    });
    this.gateway.emitTaskUpdated(task.responsavel_id, task);
    return task;
  }

  async markOverdueBatch() {
    const now = new Date();
    const due = await this.prisma.task.findMany({
      where: { status: TaskStatus.PENDENTE, scheduled_at: { lt: now } },
      select: { id: true, titulo: true, responsavel_id: true },
    });
    if (due.length === 0) return { updated: 0 };
    await this.prisma.task.updateMany({
      where: { id: { in: due.map((t) => t.id) } },
      data: { status: TaskStatus.ATRASADA },
    });
    for (const t of due) {
      this.gateway.emitTaskOverdue(t.responsavel_id, {
        taskId: t.id,
        titulo: t.titulo,
        responsavel_id: t.responsavel_id,
      });
    }
    return { updated: due.length };
  }
}
