import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser } from '../../common/types/auth-user';
import { assertPartnerTenant, businessToday } from './partners.domain';
import { dateSchema, monthSchema } from './partners.schemas';

export const teamManager = (user: AuthUser) => ['SUPER_ADMIN', 'GERENTE'].includes(user.role);
export function authorizeTeam(user: AuthUser, write = false) {
  assertPartnerTenant(user.tenantId);
  if (!user.ativo || !(write ? ['SUPER_ADMIN', 'GERENTE', 'OPERADOR'] : ['SUPER_ADMIN', 'GERENTE', 'OPERADOR', 'VISUALIZADOR']).includes(user.role)) throw new ForbiddenException('Permissão insuficiente.');
}
export function parseTeam<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(i => i.message).join('; '));
  return result.data;
}
export const teamKind = z.enum(['meeting', 'registration', 'training']);
const completedDate = dateSchema.refine(v => v >= '2000-01-01' && v <= businessToday(), 'Informe a data de uma atividade já realizada.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido.');
const eventFields = { consultant_id: z.string().uuid(), occurred_on: completedDate, occurred_time: time, note: z.string().trim().max(2000).default('') };
export const teamCreateSchema = z.object({ ...eventFields, request_id: z.string().uuid(), kind: teamKind, subject_type: z.enum(['lead', 'partner']), subject_id: z.string().uuid(), company_name: z.string().trim().max(200).optional() }).strict();
export const teamUpdateSchema = z.object({ ...eventFields, expectedVersion: z.number().int().positive() }).strict();
export const teamCancelSchema = z.object({ expectedVersion: z.number().int().positive(), cancelled: z.boolean(), reason: z.string().trim().min(3, 'Informe o motivo.').max(1000) }).strict();
export const teamFilterSchema = z.object({ month: monthSchema.default(() => businessToday().slice(0, 7)), consultant_id: z.string().uuid().optional(), kind: teamKind.optional(), status: z.enum(['active', 'cancelled', 'all']).default('active'), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict();
export const consultantGoalSchema = z.object({ target: z.number().int().min(0).max(100000), expectedVersion: z.number().int().min(0) }).strict();
export function teamDedupeKey(kind: string, subject: string, date: string, hour: string) {
  return kind === 'registration' ? `registration:${subject}` : `${kind}:${subject}:${date}:${hour}`;
}
export function teamProgress(actual: number, target: number | null) {
  return { target, remaining: target === null ? null : Math.max(0, target - actual), percentage: target === null || target === 0 ? null : Math.round(actual / target * 1000) / 10 };
}
