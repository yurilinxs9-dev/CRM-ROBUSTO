import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';
import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID } from './pl-sales';
import { isPlSalesOnly } from './pl-sales-access';

interface BoardUser {
  id?: string;
  tenantId?: string;
  role?: string;
  pl_sales_only?: boolean;
  focus_mode?: boolean;
}

interface BoardStage { id: string; user_id?: string | null }

/** The tenant-wide switch stays separate from the PL-only personal exception. */
export function getKanbanBoardContext({ user, tenantIndividual, pipelineId, selectedViewerId, stages = [] }: {
  user?: BoardUser | null;
  tenantIndividual: boolean;
  pipelineId?: string | null;
  selectedViewerId: string;
  stages?: readonly BoardStage[];
}) {
  const restricted = isPlSalesOnly(user);
  const showViewAs = !restricted && !user?.focus_mode && ['GERENTE', 'SUPER_ADMIN'].includes(user?.role ?? '');
  const viewAsApplied = showViewAs && selectedViewerId ? selectedViewerId : 'ALL';
  const plPipeline = user?.tenantId === PARTNERS_TENANT && pipelineId === PL_PIPELINE_ID;
  const ownPlBoard = plPipeline && restricted && user?.role === 'OPERADOR';
  const pipelineParams: Record<string, string> = {};
  // The server chooses personal vs base for this member. No extra user-list
  // permission or profile metadata is needed to discover their stage ownership.
  if ((tenantIndividual || plPipeline) && viewAsApplied !== 'ALL') pipelineParams.view_as_user_id = viewAsApplied;
  const personalBoard = tenantIndividual || ownPlBoard ||
    (plPipeline && viewAsApplied !== 'ALL' && stages.some(stage => stage.user_id === viewAsApplied));
  const stagesReadOnly = (restricted && !ownPlBoard) ||
    (personalBoard && viewAsApplied !== 'ALL' && viewAsApplied !== user?.id);
  return {
    showViewAs, viewAsApplied, pipelineParams, personalBoard, stagesReadOnly,
    // The PL base view can contain leads from private seller stages too.
    // Project their cards like the API without changing stage edit permissions.
    projectUnknownStages: personalBoard || plPipeline,
    canConfigureStages: !restricted && !stagesReadOnly,
    viewAsResolved: !(tenantIndividual && showViewAs && viewAsApplied === 'ALL'),
    cacheScope: JSON.stringify([user?.tenantId, user?.id, user?.role, restricted, user?.focus_mode === true, tenantIndividual, pipelineId, viewAsApplied]),
  };
}

export const personalStagePatchSchema = z.object({
  nome: z.string().trim().min(1).max(100).optional(),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

export function stageColumnFor(stageId: string, stages: readonly BoardStage[], projectUnknownStages: boolean, stageColumns: Readonly<Record<string, string>> = {}): string | undefined {
  if (stages.some(stage => stage.id === stageId)) return stageId;
  const mapped = projectUnknownStages ? stageColumns[stageId] : undefined;
  return mapped && stages.some(stage => stage.id === mapped) ? mapped : projectUnknownStages ? stages[0]?.id : undefined;
}

/** PL pages use the same displayed-column membership as the initial board. */
export function stagePageParams({ tenantId, pipelineId, stageId, stages, leads, pageSize, stageColumns }: {
  tenantId?: string;
  pipelineId: string;
  stageId: string;
  stages: readonly BoardStage[];
  leads: readonly { estagio_id: string }[];
  pageSize: number;
  stageColumns?: Readonly<Record<string, string>>;
}) {
  const plBoard = tenantId === PARTNERS_TENANT && pipelineId === PL_PIPELINE_ID;
  const loaded = leads.filter(lead =>
    (plBoard ? stageColumnFor(lead.estagio_id, stages, true, stageColumns) : lead.estagio_id) === stageId,
  ).length;
  return {
    pipeline_id: pipelineId,
    offset: String(loaded),
    ...(plBoard
      ? { per_stage: String(pageSize), board_stage_id: stageId }
      : { limit: String(pageSize), estagio_id: stageId }),
  };
}

/** Supports both raw totals and totals already projected by the API. */
export function visibleStageTotals(totals: Record<string, number>, stages: readonly BoardStage[], projectUnknownStages: boolean, stageColumns?: Readonly<Record<string, string>>): Record<string, number> {
  if (!projectUnknownStages) return totals;
  const result: Record<string, number> = {};
  for (const [id, total] of Object.entries(totals)) {
    const column = stageColumnFor(id, stages, projectUnknownStages, stageColumns);
    if (column) result[column] = (result[column] ?? 0) + total;
  }
  return result;
}

export function stageCountsAfterMove(totals: Record<string, number>, from: string, to: string, stages: readonly BoardStage[], projectUnknownStages: boolean, stageColumns?: Readonly<Record<string, string>>): Record<string, number> {
  const counts = { ...visibleStageTotals(totals, stages, projectUnknownStages, stageColumns) };
  const source = stageColumnFor(from, stages, projectUnknownStages, stageColumns) ?? from;
  if (source !== to) {
    counts[source] = Math.max(0, (counts[source] ?? 1) - 1);
    counts[to] = (counts[to] ?? 0) + 1;
  }
  return counts;
}

export function keepBoardDataInScope<T>(previous: T | undefined, previousKey: readonly unknown[] | undefined, scope: string): T | undefined {
  return previousKey?.[0] === 'leads' && previousKey[1] === scope ? previous : undefined;
}

export async function invalidateStageBoardQueries(client: QueryClient, payload: { pipelineId: string; ownerId: string | null }, activePipelineId: string | null) {
  if (payload.pipelineId !== activePipelineId) return;
  await Promise.all([
    client.invalidateQueries({ queryKey: ['pipelines'] }),
    client.invalidateQueries({ queryKey: ['leads'] }),
    client.invalidateQueries({ queryKey: ['dashboard-stats'] }),
    client.invalidateQueries({ predicate: query => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('analytics-') }),
  ]);
}
