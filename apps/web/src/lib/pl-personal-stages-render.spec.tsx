import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, type UseQueryOptions } from '@tanstack/react-query';
import { StageColumn } from '@/components/kanban/stage-column';
import { KanbanWorkspace } from '@/components/kanban/kanban-workspace';
import { api } from './api';
import { FILTROS_VAZIOS } from './lead-filters';
import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID } from './pl-sales';

const mockUser = { id: 'seller-a', role: 'OPERADOR', tenantId: PARTNERS_TENANT, pl_sales_only: true, focus_mode: false };
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: Object.assign((selector: (state: { user: typeof mockUser }) => unknown) => selector({ user: mockUser }), {
    getState: () => ({ user: mockUser, tenant: { kanban_individual: false } }),
  }),
  useIsPlSalesOnly: () => mockUser.pl_sales_only,
  useIsKanbanIndividual: () => false,
  useIsPoolEnabled: () => false,
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock('@/lib/api', () => ({ api: { get: jest.fn() } }));
jest.mock('@/components/leads/use-lead-view', () => ({ useLeadView: () => ({ filters: FILTROS_VAZIOS, config: { card_fields: [], sort: null } }) }));
// Unopened forms are outside these board/query regressions.
jest.mock('@/components/kanban/lead-filter-panel', () => ({ LeadFilterPanel: () => null }));
jest.mock('@/components/kanban/new-lead-dialog', () => ({ NewLeadDialog: () => null }));
jest.mock('@/components/kanban/lead-detail-drawer', () => ({ LeadDetailDrawer: () => null }));

// Reveal the real column's menu items without a browser portal. The production
// column still decides which actions exist; drag-and-drop and cards stay real.
jest.mock('@/components/ui/dropdown-menu', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { DropdownMenu: Container, DropdownMenuContent: Container, DropdownMenuTrigger: Container, DropdownMenuItem: Container, DropdownMenuSeparator: () => <hr /> };
});

function column(stagesReadOnly = false, limitedStageEditing = true) {
  return renderToStaticMarkup(<StageColumn
    stage={{ id: 'own-stage', user_id: 'seller', nome: 'Minha negociação', cor: '#123456', ordem: 0, is_won: true }}
    leads={[]} totalCount={7}
    onClickLead={jest.fn()} onAddLead={jest.fn()} onRenameStage={jest.fn()} onChangeColor={jest.fn()}
    onDuplicateStage={jest.fn()} onDeleteStage={jest.fn()} onConfigureStage={jest.fn()} onMoveStage={jest.fn()}
    canMoveLeft={false} canMoveRight stagesReadOnly={stagesReadOnly} limitedStageEditing={limitedStageEditing}
  />);
}

it('offers only name, color and ordering controls for a PL seller column', () => {
  const html = column();
  for (const allowed of ['Renomear', 'Mudar cor', 'Reordenar etapa', 'Mover para direita', 'Etapa de ganho']) expect(html).toContain(allowed);
  for (const forbidden of ['Configurar', 'Duplicar', 'Excluir']) expect(html).not.toContain(forbidden);
  expect(html).toContain('Minha negociação');
  expect(html).toMatch(/>7<\/span>/);
});

it('hides every stage edit when management views another member board', () => {
  const html = column(true, false);
  for (const forbidden of ['Renomear', 'Mudar cor', 'Reordenar etapa', 'Configurar', 'Duplicar', 'Excluir', 'Opcoes da etapa']) expect(html).not.toContain(forbidden);
  expect(html).toContain('Adicionar lead');
});

it('preserves existing shared-board stage controls', () => {
  const html = column(false, false);
  for (const allowed of ['Configurar', 'Duplicar', 'Excluir', 'Renomear', 'Mudar cor']) expect(html).toContain(allowed);
});

describe('personal Kanban queries and rendering', () => {
  let client: QueryClient;
  const get = jest.mocked(api.get);
  let pipelineReply: unknown;
  let leadReply: unknown;

  function markup() {
    return renderToStaticMarkup(<QueryClientProvider client={client}><KanbanWorkspace fixedPipelineId={PL_PIPELINE_ID} /></QueryClientProvider>);
  }

  async function load() {
    const fetched = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      markup();
      for (const query of client.getQueryCache().getAll()) {
        const options = query.options as UseQueryOptions;
        if (options.enabled === false || fetched.has(query.queryHash)) continue;
        fetched.add(query.queryHash);
        await client.fetchQuery(options);
      }
    }
    return markup();
  }

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    Object.assign(mockUser, { id: 'seller-a', role: 'OPERADOR', pl_sales_only: true });
    pipelineReply = [{ id: PL_PIPELINE_ID, nome: 'Consórcio PL', stages: [{ id: 'own-stage', user_id: 'seller-a', nome: 'Minha negociação', cor: '#123456', ordem: 0 }] }];
    leadReply = { leads: [{ id: 'lead-a', nome: 'Cliente atribuído', telefone: '11999999999', temperatura: 'FRIO', estagio_id: 'foreign-stage', mensagens_nao_lidas: 0 }], stage_counts: { 'own-stage': 1 }, stage_values: {} };
    get.mockReset();
    get.mockImplementation(async url => {
      if (url === '/api/pipelines') return { data: pipelineReply };
      if (url === '/api/leads') return { data: leadReply };
      if (url === '/api/users/list') return { data: [] };
      throw new Error(`Unexpected request: ${url}`);
    });
  });
  afterEach(() => client.clear());

  it('loads only own PL board/leads and renders limited stage controls with the global switch off', async () => {
    const html = await load();
    expect(get.mock.calls.map(([url]) => url).sort()).toEqual(['/api/leads', '/api/pipelines']);
    expect(get).toHaveBeenCalledWith('/api/pipelines', { params: {} });
    expect(get).toHaveBeenCalledWith('/api/leads', { params: { pipeline_id: PL_PIPELINE_ID, per_stage: '50', owner: 'me' } });
    for (const text of ['Minha negociação', 'Cliente atribuído', 'Adicionar Etapa', 'Renomear', 'Mudar cor']) expect(html).toContain(text);
    for (const text of ['Configurar', 'Duplicar', 'Excluir etapa', 'Ver como membro']) expect(html).not.toContain(text);
  });

  it('does not render cached base or another seller board after account/access changes', async () => {
    mockUser.pl_sales_only = false;
    pipelineReply = [{ id: PL_PIPELINE_ID, nome: 'Consórcio PL', stages: [{ id: 'base', user_id: null, nome: 'Base confidencial', cor: '#123456', ordem: 0 }] }];
    await load();
    mockUser.pl_sales_only = true;
    expect(markup()).not.toContain('Base confidencial');
    pipelineReply = [{ id: PL_PIPELINE_ID, nome: 'Consórcio PL', stages: [{ id: 'own-stage', user_id: 'seller-a', nome: 'Minha negociação', cor: '#123456', ordem: 0 }] }];
    await load();
    mockUser.id = 'seller-b';
    expect(markup()).not.toContain('Minha negociação');
    expect(markup()).not.toContain('Cliente atribuído');
  });

  it('keeps manager ALL on base stages while showing returned private-stage cards', async () => {
    Object.assign(mockUser, { id: 'manager', role: 'GERENTE', pl_sales_only: false });
    pipelineReply = [{ id: PL_PIPELINE_ID, nome: 'Consórcio PL', stages: [{ id: 'base', user_id: null, nome: 'Etapa base', cor: '#123456', ordem: 0 }] }];
    leadReply = { ...leadReply as object, stage_counts: { base: 1 } };
    const html = await load();
    expect(get).toHaveBeenCalledWith('/api/pipelines', { params: {} });
    expect(get).toHaveBeenCalledWith('/api/leads', { params: { pipeline_id: PL_PIPELINE_ID, per_stage: '50' } });
    for (const text of ['Etapa base', 'Cliente atribuído', 'Configurar', 'Duplicar', 'Adicionar Etapa']) expect(html).toContain(text);
  });
});
