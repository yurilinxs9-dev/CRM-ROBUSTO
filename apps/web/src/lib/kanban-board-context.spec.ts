import { QueryClient } from '@tanstack/react-query';
import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID } from './pl-sales';
import { getKanbanBoardContext, stagePageParams, stageColumnFor, visibleStageTotals, stageCountsAfterMove, keepBoardDataInScope, personalStagePatchSchema, invalidateStageBoardQueries } from './kanban-board-context';

const seller = { id: 'seller-a', tenantId: PARTNERS_TENANT, role: 'OPERADOR', pl_sales_only: true };
const manager = { ...seller, id: 'manager', role: 'GERENTE', pl_sales_only: false };
const ownStages = [{ id: 'personal-first', user_id: seller.id }, { id: 'personal-won', user_id: seller.id }];
const base = { user: seller, tenantIndividual: false, pipelineId: PL_PIPELINE_ID, selectedViewerId: 'ALL', stages: ownStages };

describe('PL personal board context', () => {
  it('accepts visual fields only, without terminal flags or automation settings', () => {
    expect(personalStagePatchSchema.parse({ nome: ' Minha etapa ', cor: '#12ABef' })).toEqual({ nome: 'Minha etapa', cor: '#12ABef' });
    for (const patch of [{ is_won: true }, { is_lost: true }, { auto_action: {} }, { scope: 'base' }, { user_id: 'other' }, { ordem: 2 }, { nome: '' }, { cor: 'red' }]) {
      expect(personalStagePatchSchema.safeParse(patch).success).toBe(false);
    }
  });
  it('allows visual editing on the opted-in seller board with the global switch off', () => {
    const context = getKanbanBoardContext(base);
    expect(context.personalBoard).toBe(true);
    expect(context.stagesReadOnly).toBe(false);
    expect(context.canConfigureStages).toBe(false);
    expect(context.showViewAs).toBe(false);
    expect(context.pipelineParams).toEqual({});
    expect(context.viewAsApplied).toBe('ALL');
  });

  it('does not turn every PL manager board into an individual board', () => {
    const baseStages = [{ id: 'base', user_id: null }];
    const context = getKanbanBoardContext({ ...base, user: manager, stages: baseStages });
    expect(context.personalBoard).toBe(false);
    expect(context.stagesReadOnly).toBe(false);
    expect(context.canConfigureStages).toBe(true);
    expect(context.pipelineParams).toEqual({});
    expect(context.viewAsResolved).toBe(true);
    expect(stageColumnFor('seller-private-stage', baseStages, context.projectUnknownStages)).toBe('base');
    expect(visibleStageTotals({ base: 2, 'seller-private-stage': 3 }, baseStages, context.projectUnknownStages)).toEqual({ base: 5 });
  });

  it('requests the selected seller board with global mode off and forbids editing her columns', () => {
    const context = getKanbanBoardContext({ ...base, user: manager, selectedViewerId: seller.id });
    expect(context.pipelineParams).toEqual({ view_as_user_id: seller.id });
    expect(context.viewAsApplied).toBe(seller.id);
    expect(context.personalBoard).toBe(true);
    expect(context.stagesReadOnly).toBe(true);
    expect(context.canConfigureStages).toBe(false);
  });

  it('keeps a selected ordinary member on shared base stages', () => {
    const context = getKanbanBoardContext({ ...base, user: manager, selectedViewerId: 'ordinary', stages: [{ id: 'base', user_id: null }] });
    expect(context.pipelineParams).toEqual({ view_as_user_id: 'ordinary' });
    expect(context.personalBoard).toBe(false);
    expect(context.stagesReadOnly).toBe(false);
  });

  it.each([
    { ...seller, role: 'GERENTE' },
    { ...seller, tenantId: 'another-tenant' },
  ])('does not enable personal stage writes for invalid opted-in profiles', user => {
    expect(getKanbanBoardContext({ ...base, user }).stagesReadOnly).toBe(true);
  });

  it('never applies the PL exception to another pipeline or a non-opted-in operator', () => {
    expect(getKanbanBoardContext({ ...base, pipelineId: 'other' }).stagesReadOnly).toBe(true);
    expect(getKanbanBoardContext({ ...base, user: { ...seller, pl_sales_only: false }, stages: [] }).personalBoard).toBe(false);
    const context = getKanbanBoardContext({ ...base, user: manager, pipelineId: 'other', selectedViewerId: seller.id });
    expect(context.pipelineParams).toEqual({});
    expect(context.personalBoard).toBe(false);
    expect(context.projectUnknownStages).toBe(false);
  });

  it.each([seller, { ...manager, focus_mode: true }])('ignores another viewer when the account cannot supervise', user => {
    const context = getKanbanBoardContext({ ...base, user, selectedViewerId: 'someone-else' });
    expect(context.showViewAs).toBe(false);
    expect(context.viewAsApplied).toBe('ALL');
    expect(context.pipelineParams).toEqual({});
  });

  it('preserves tenant-wide individual mode including the unresolved manager guard', () => {
    const context = getKanbanBoardContext({ ...base, user: manager, pipelineId: 'other', tenantIndividual: true, selectedViewerId: seller.id });
    expect(context.personalBoard).toBe(true);
    expect(context.stagesReadOnly).toBe(true);
    expect(context.pipelineParams).toEqual({ view_as_user_id: seller.id });
    expect(getKanbanBoardContext({ ...base, user: manager, tenantIndividual: true }).viewAsResolved).toBe(false);
  });

  it('separates cached stages/cards by account, access role, restriction, viewer and board mode', () => {
    const client = new QueryClient();
    const original = getKanbanBoardContext(base).cacheScope;
    client.setQueryData(['pipelines', original], ['private-stage']);
    client.setQueryData(['leads', original, {}], ['private-lead']);
    const alternatives = [
      { ...base, user: { ...seller, id: 'seller-b' } },
      { ...base, user: { ...seller, role: 'GERENTE' } },
      { ...base, user: { ...seller, pl_sales_only: false } },
      { ...base, user: { ...seller, tenantId: 'another' } },
      { ...base, tenantIndividual: true },
      { ...base, user: manager, selectedViewerId: seller.id },
      { ...base, user: manager, selectedViewerId: 'seller-b' },
    ];
    for (const input of alternatives) {
      const scope = getKanbanBoardContext(input).cacheScope;
      expect(client.getQueryData(['pipelines', scope])).toBeUndefined();
      expect(client.getQueryData(['leads', scope, {}])).toBeUndefined();
    }
    expect(getKanbanBoardContext({ ...base, user: manager, selectedViewerId: seller.id }).cacheScope)
      .not.toBe(getKanbanBoardContext({ ...base, user: manager, selectedViewerId: 'seller-b' }).cacheScope);
    client.clear();
  });

  it('keeps previous cards for filters within one scope but never across viewers or accounts', () => {
    const previous = { leads: ['lead-a'] };
    const scope = getKanbanBoardContext(base).cacheScope;
    expect(keepBoardDataInScope(previous, ['leads', scope, { search: 'old' }], scope)).toBe(previous);
    const other = getKanbanBoardContext({ ...base, user: { ...seller, id: 'seller-b' } }).cacheScope;
    expect(keepBoardDataInScope(previous, ['leads', scope, {}], other)).toBeUndefined();
    expect(keepBoardDataInScope(previous, ['leads', PL_PIPELINE_ID, {}], scope)).toBeUndefined();
  });

  it('projects unknown stage cards and server totals to the same first personal column without double counting', () => {
    expect(stageColumnFor('old-owner-stage', ownStages, true)).toBe('personal-first');
    expect(stageColumnFor('personal-won', ownStages, true)).toBe('personal-won');
    expect(visibleStageTotals({ 'personal-first': 2, 'old-owner-stage': 3, 'personal-won': 1 }, ownStages, true))
      .toEqual({ 'personal-first': 5, 'personal-won': 1 });
    expect(visibleStageTotals({ 'personal-first': 5, 'personal-won': 1 }, ownStages, true))
      .toEqual({ 'personal-first': 5, 'personal-won': 1 });
    expect(stageColumnFor('old-owner-stage', ownStages, false)).toBeUndefined();
    expect(stageColumnFor('old-owner-stage', [], true)).toBeUndefined();
  });

  it('keeps projected counts correct when a fallback card is moved or dropped in its visible column', () => {
    const totals = { 'personal-first': 5, 'personal-won': 1 };
    expect(stageCountsAfterMove(totals, 'old-owner-stage', 'personal-won', ownStages, true))
      .toEqual({ 'personal-first': 4, 'personal-won': 2 });
    expect(stageCountsAfterMove(totals, 'old-owner-stage', 'personal-first', ownStages, true)).toEqual(totals);
    expect(stageCountsAfterMove({ 'old-owner-stage': 5, 'personal-won': 1 }, 'old-owner-stage', 'personal-won', ownStages, true))
      .toEqual({ 'personal-first': 4, 'personal-won': 2 });
    expect(stageCountsAfterMove(totals, 'personal-first', 'personal-won', ownStages, false))
      .toEqual({ 'personal-first': 4, 'personal-won': 2 });
  });

  it('paginates the displayed PL base column including cards from unknown personal stages', () => {
    const params = stagePageParams({
      tenantId: PARTNERS_TENANT, pipelineId: PL_PIPELINE_ID, stageId: 'base', pageSize: 50,
      stages: [{ id: 'base' }, { id: 'contact' }],
      leads: [{ estagio_id: 'base' }, { estagio_id: 'seller-private' }, { estagio_id: 'other-private' }, { estagio_id: 'contact' }],
    });
    expect(params).toEqual({ pipeline_id: PL_PIPELINE_ID, per_stage: '50', board_stage_id: 'base', offset: '3' });
  });

  it('keeps known PL columns separate when calculating the next page offset', () => {
    expect(stagePageParams({
      tenantId: PARTNERS_TENANT, pipelineId: PL_PIPELINE_ID, stageId: 'contact', pageSize: 50,
      stages: [{ id: 'base' }, { id: 'contact' }],
      leads: [{ estagio_id: 'base' }, { estagio_id: 'seller-private' }, { estagio_id: 'contact' }],
    })).toEqual({ pipeline_id: PL_PIPELINE_ID, per_stage: '50', board_stage_id: 'contact', offset: '1' });
  });

  it.each([
    { tenantId: PARTNERS_TENANT, pipelineId: 'partners' },
    { tenantId: 'another-tenant', pipelineId: PL_PIPELINE_ID },
  ])('preserves exact-stage pagination outside the PL board: $tenantId/$pipelineId', scope => {
    expect(stagePageParams({
      ...scope, stageId: 'base', pageSize: 50, stages: [{ id: 'base' }],
      leads: [{ estagio_id: 'base' }, { estagio_id: 'seller-private' }],
    })).toEqual({ pipeline_id: scope.pipelineId, estagio_id: 'base', limit: '50', offset: '1' });
  });

  it('invalidates columns, cards and report caches for a matching stage-change event only', async () => {
    const client = new QueryClient();
    const scope = getKanbanBoardContext(base).cacheScope;
    const keys = [['pipelines', scope], ['leads', scope, {}], ['dashboard-stats', seller.id], ['analytics-funnel', seller.id], ['analytics-conversion', seller.id]];
    for (const key of keys) client.setQueryData(key, { value: 1 });
    client.setQueryData(['partners'], { value: 1 });
    await invalidateStageBoardQueries(client, { pipelineId: 'unrelated', ownerId: seller.id }, PL_PIPELINE_ID);
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    await invalidateStageBoardQueries(client, { pipelineId: PL_PIPELINE_ID, ownerId: seller.id }, PL_PIPELINE_ID);
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState(['partners'])?.isInvalidated).toBe(false);
    client.clear();
  });
});
