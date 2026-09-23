import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrismaService } from '../../common/prisma/prisma.service';

export const audienceSchema = z.object({
  stage_id: z.string().uuid().nullable().optional(),
  // The original seeded pipeline predates UUID identifiers.
  pipeline_id: z.union([z.string().uuid(), z.literal('pipeline-default')]).nullable().optional(),
  responsavel_id: z.string().uuid().nullable().optional(),
  temperatura: z.enum(['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE']).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  inactive_days: z.number().int().min(0).max(365).optional(),
  exclude_closed: z.boolean().optional(),
  lead_ids: z.array(z.string().uuid()).min(1).max(500).nullable().optional(),
}).strict();

export const campaignSchema = audienceSchema.extend({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(['template', 'ai']),
  template: z.string().max(2000).nullable().optional(),
  ai_instruction: z.string().max(2000).nullable().optional(),
  model_config_id: z.string().uuid().nullable().optional(),
  throttle_seconds: z.number().int().min(30).max(86400).optional(),
  daily_limit: z.number().int().min(1).max(200).optional(),
  respect_ai_block: z.boolean().optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  window_start: z.number().int().min(0).max(23).optional(),
  window_end: z.number().int().min(1).max(24).optional(),
  window_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
}).strict().refine(v => v.window_start === undefined || v.window_end === undefined || v.window_start < v.window_end,
  { message: 'O horário final deve ser maior que o inicial', path: ['window_end'] });

export const previewSchema = audienceSchema.extend({
  mode: z.enum(['template', 'ai']),
  template: z.string().max(2000).nullable().optional(),
  ai_instruction: z.string().max(2000).nullable().optional(),
  model_config_id: z.string().uuid().nullable().optional(),
}).strict();
export type CampaignInput = z.infer<typeof campaignSchema>;
export type AudienceInput = z.infer<typeof audienceSchema>;

export function audienceWhere(tenantId: string, input: AudienceInput, now = new Date()): Prisma.LeadWhereInput {
  const clauses: Prisma.LeadWhereInput[] = [];
  if (input.tags?.length) clauses.push({ OR: input.tags.map(tag => ({ tags: { array_contains: [tag] } })) });
  if (input.inactive_days) {
    const cutoff = new Date(now.getTime() - input.inactive_days * 86400000);
    clauses.push({ OR: [{ ultima_interacao: { lte: cutoff } }, { ultima_interacao: null, created_at: { lte: cutoff } }] });
  }
  return {
    tenant_id: tenantId,
    ...(input.lead_ids?.length ? { id: { in: [...new Set(input.lead_ids)] } } : {}),
    ...(input.stage_id ? { estagio_id: input.stage_id } : {}),
    ...(input.pipeline_id ? { pipeline_id: input.pipeline_id } : {}),
    ...(input.responsavel_id ? { responsavel_id: input.responsavel_id } : {}),
    ...(input.temperatura ? { temperatura: input.temperatura } : {}),
    ...(input.exclude_closed !== false ? { estagio: { is_won: false, is_lost: false } } : {}),
    ...(clauses.length ? { AND: clauses } : {}),
  };
}

export function campaignOptions(value: Prisma.JsonValue | null): Partial<CampaignInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Partial<CampaignInput>;
}

/** Base-stage selection must include the corresponding personal Kanban stages. */
export async function resolveAudienceWhere(prisma: PrismaService, tenantId: string, input: AudienceInput): Promise<Prisma.LeadWhereInput> {
  const where = audienceWhere(tenantId, input);
  if (!input.stage_id) return where;
  const stage = await prisma.stage.findFirst({ where: { id: input.stage_id, tenant_id: tenantId }, select: { nome: true, pipeline_id: true, user_id: true } });
  if (!stage) return { tenant_id: tenantId, id: { in: [] } };
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { kanban_individual: true } });
  if (!stage.user_id && tenant?.kanban_individual) {
    delete where.estagio_id;
    const existing = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [...existing, { estagio: { nome: stage.nome, pipeline_id: stage.pipeline_id, tenant_id: tenantId } }];
  }
  return where;
}
