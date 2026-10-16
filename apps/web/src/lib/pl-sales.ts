import { isAxiosError } from 'axios';
import { z } from 'zod';
import { brl, PARTNERS_TENANT, parsePartnerAmount, saoPauloDate } from './partners';

export const PL_PIPELINE_ID = '6f749216-8d83-44ed-8fd0-1c57720c9f11';
export const canAccessPlSales = (tenant: string, role: string) => tenant === PARTNERS_TENANT && ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'].includes(role);
export const plSalesKey = (tenant: string, userId: string, role: string) => ['pl-sales', tenant, userId, role] as const;

export interface PlSale {
  id: string; lead_id: string; customer_name: string; customer_phone: string;
  seller_id: string; seller_name: string; contract_number: string; amount: string;
  sold_on: string; status: 'ACTIVE' | 'CANCELLED'; note: string; version: number;
  created_at: string; updated_at: string;
}
export interface PlGoal { id: string; month: string; owner_key: string; owner_name: string; amount: string; version: number }
export interface PlMember { id: string; name: string }
export interface PlCandidate { id: string; nome: string; telefone: string; responsavel_id: string | null }
export interface PlRanking { seller_id: string; seller_name: string; amount: string; contracts: number; target: string | null }
export interface PlDashboard {
  month: string; pipeline_id: string; manager: boolean; page: number; total: number; hasMore: boolean;
  summary: { total: string; contracts: number; target: string | null; remaining: string | null; percentage: number | null };
  ranking: PlRanking[]; goals: PlGoal[]; members: PlMember[]; sales: PlSale[];
}
export interface PlAudit { id: string; entity_id: string; actor_name: string; action: string; before: unknown; after: unknown; created_at: string }

const amountSchema = z.string().transform((value, ctx) => {
  try { return parsePartnerAmount(value); }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Informe um valor válido.' }); return z.NEVER; }
});
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data de fechamento.').refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1900;
}, 'Informe uma data válida.').refine(value => value <= saoPauloDate(), 'A data de fechamento não pode ser futura.');

export const plSaleSchema = z.object({
  lead_id: z.string().uuid('Selecione um cliente do funil Consórcio PL.'),
  seller_id: z.string().uuid('Selecione uma pessoa da equipe comercial.'),
  contract_number: z.string().trim().min(1, 'Informe o número do contrato.').max(120, 'O contrato deve ter até 120 caracteres.').transform(value => value.toUpperCase()),
  amount: amountSchema.refine(value => Number(value) > 0, 'O crédito contratado deve ser maior que zero.'),
  sold_on: dateSchema,
  note: z.string().trim().max(3000, 'A observação deve ter até 3.000 caracteres.'),
}).strict();
export const plGoalSchema = z.object({ amount: amountSchema, expectedVersion: z.number().int().min(0) }).strict();
export const plCancelSchema = z.object({
  reason: z.string().trim().min(3, 'Explique o motivo do cancelamento (ao menos 3 caracteres).').max(1000, 'O motivo deve ter até 1.000 caracteres.'),
  expectedVersion: z.number().int().positive(),
}).strict();

export function plError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Confira os campos informados.';
  if (isAxiosError<{ message?: unknown }>(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((item): item is string => typeof item === 'string')) return message.join(' ');
    if (!error.response) return 'Sem conexão com o servidor. Atualize a lista para conferir se o registro foi salvo antes de tentar novamente.';
    return 'Não foi possível concluir a operação. Confira os dados e tente novamente.';
  }
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}

export const plDate = (value: string) => value.slice(0, 10).split('-').reverse().join('/');
export const plMonth = (value: string) => value.split('-').reverse().join('/');
export const plPercentage = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function plRanking(data: PlDashboard): PlRanking[] {
  const rows = new Map(data.ranking.map(row => [row.seller_id, { ...row }]));
  for (const member of data.members) {
    const existing = rows.get(member.id);
    rows.set(member.id, {
      seller_id: member.id, seller_name: member.name, amount: existing?.amount ?? '0.00', contracts: existing?.contracts ?? 0,
      target: data.goals.find(goal => goal.owner_key === member.id)?.amount ?? existing?.target ?? null,
    });
  }
  return [...rows.values()].sort((a, b) => Number(b.amount) - Number(a.amount) || a.seller_name.localeCompare(b.seller_name, 'pt-BR'));
}

export function plAuditDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Sem registro anterior';
  const row = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof row.customer_name === 'string') parts.push(row.customer_name);
  if (typeof row.contract_number === 'string') parts.push(`Contrato ${row.contract_number}`);
  if (typeof row.seller_name === 'string') parts.push(`Vendedor: ${row.seller_name}`);
  if (typeof row.owner_name === 'string') parts.push(`Meta: ${row.owner_name}`);
  if (typeof row.month === 'string') parts.push(plMonth(row.month));
  if (typeof row.amount === 'string' || typeof row.amount === 'number') parts.push(`Crédito: ${brl(row.amount)}`);
  if (typeof row.sold_on === 'string') parts.push(plDate(row.sold_on));
  if (row.status === 'ACTIVE') parts.push('Ativa');
  if (row.status === 'CANCELLED') parts.push('Cancelada');
  if (typeof row.note === 'string') parts.push(row.note ? `Observação: ${row.note}` : 'Sem observação');
  if (typeof row.reason === 'string') parts.push(`Motivo: ${row.reason}`);
  return parts.join(' · ') || 'Dados atualizados';
}
