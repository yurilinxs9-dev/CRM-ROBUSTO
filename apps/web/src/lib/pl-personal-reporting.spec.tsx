import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver, type UseQueryOptions } from '@tanstack/react-query';
import DashboardPage from '@/app/(dashboard)/dashboard/page';
import AnalyticsPage from '@/app/(dashboard)/analytics/page';
import { Sidebar } from '@/components/layout/sidebar';
import { api } from './api';
import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID, type PlDashboard } from './pl-sales';

const mockUser = {
  id: 'seller-one', nome: 'Minha conta', role: 'OPERADOR', tenantId: PARTNERS_TENANT,
  pl_sales_only: true, focus_mode: false,
};
let mockSearchParams = new URLSearchParams('from=2026-10-01&to=2026-10-19&pipeline_id=other-pipeline');

jest.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: { user: typeof mockUser }) => unknown) => selector({ user: mockUser }),
  useIsPlSalesOnly: () => mockUser.pl_sales_only,
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard',
}));
jest.mock('@/lib/api', () => ({ api: { get: jest.fn() } }));

const stats = {
  leadsByStage: [], totalLeads: 12, leadsThisWeek: 5, leadsLastWeek: 2, leadsThisMonth: 8,
  conversionRate: 25, avgResponseMinutes: 0, responseSamples: 0, wonValue: 987654,
  openConversations: 3, pendingTasks: 2, leadsTrend: [], leadsByTemp: [], recentActivity: [],
  topOperators: [{ id: 'other', nome: 'Outro vendedor', leadsCount: 100, messagesSent: 80, avgResponse: 10 }],
};
const sales: PlDashboard = {
  month: '2026-10', pipeline_id: PL_PIPELINE_ID, manager: false, page: 1, total: 2, hasMore: false,
  summary: { total: '25000.00', contracts: 2, target: '100000.00', remaining: '75000.00', percentage: 25 },
  ranking: [], goals: [], members: [], sales: [],
};
const overview = {
  period: { from: '2026-10-01', to: '2026-10-19' }, total_leads: 12, open_leads: 7, total_value: 987654,
  new_leads: 8, won_leads: 3, lost_leads: 2, won_value: 987654, avg_ticket: 329218, conversion_rate: 0.25,
  previous: { new_leads: 4, won_leads: 1, lost_leads: 1, won_value: 100, avg_ticket: 100, conversion_rate: 0.1 },
};
const response = {
  period: overview.period, total_conversations: 5, unanswered: 2,
  users: [{ id: 'seller-one', nome: 'Minha conta', answered: 3, median_seconds: 60, avg_seconds: 120 }],
};

let client: QueryClient;
const get = jest.mocked(api.get);
const replies: Record<string, unknown> = {};

function markup(page: ReactElement): string {
  const html = renderToString(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
  const error = html.match(/<template data-msg="([^"]*)"/);
  if (error) throw new Error(error[1]);
  return html;
}

// SSR registers the real useQuery options without mounting effects. Execute only
// enabled queries, then render their real cached results. No browser or network.
async function load(page: ReactElement): Promise<string> {
  const fetched = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    markup(page);
    for (const query of client.getQueryCache().getAll()) {
      const options = query.options as UseQueryOptions;
      if (options.enabled === false || fetched.has(query.queryHash)) continue;
      fetched.add(query.queryHash);
      await client.fetchQuery(options).catch(() => undefined);
    }
  }
  return markup(page);
}

function requests(): string[] { return get.mock.calls.map(([url]) => url); }
function textContent(html: string): string { return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' '); }

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-19T15:00:00Z') });
  // Repeated SSR renders recreate observers; keep an observed failure settled
  // instead of treating each render as a fresh mount that retries the request.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } } });
  Object.assign(mockUser, { id: 'seller-one', role: 'OPERADOR', pl_sales_only: true });
  mockSearchParams = new URLSearchParams('from=2026-10-01&to=2026-10-19&pipeline_id=other-pipeline');
  Object.keys(replies).forEach(key => delete replies[key]);
  Object.assign(replies, {
    '/api/dashboard/stats': stats,
    '/api/dashboard/financeira': { previsao: {}, ganhos: { mes_atual: 987654 } },
    '/api/pl-sales': sales,
    '/api/pipelines': [{ id: 'other-pipeline', nome: 'Outro funil' }],
    '/api/analytics/overview': overview,
    '/api/analytics/timeseries': { period: overview.period, days: [{ day: '2026-10-18', new_leads: 5, won_leads: 1 }] },
    '/api/analytics/funnel': { pipeline_id: PL_PIPELINE_ID, stages: [] },
    '/api/analytics/conversion': { pipeline_id: PL_PIPELINE_ID, period: overview.period, stages: [] },
    '/api/analytics/time-in-stage': { pipeline_id: PL_PIPELINE_ID, stages: [] },
    '/api/analytics/forecast': { stages: [], total_forecast_value: 0, total_open_value: 0, global_win_rate: 0, closed_sample: 0 },
    '/api/analytics/first-response': response,
    '/api/analytics/performance': { period: overview.period, users: [] },
    '/api/attribution/summary': { period: overview.period, total: { leads: 0, won: 0, lost: 0, won_value: 0, conversion_rate: 0 }, channels: [], paid: { share: 0, leads: 0, won: 0, won_value: 0 } },
    '/api/attribution/campaigns': { period: overview.period, campaigns: [], keywords: [] },
  });
  get.mockReset();
  get.mockImplementation(async url => {
    if (!(url in replies)) throw new Error(`Unexpected request: ${url}`);
    if (replies[url] instanceof Error) throw replies[url];
    return { data: replies[url] };
  });
});
afterEach(() => { client.clear(); jest.useRealTimers(); });

it('renders the report menu while keeping partners and general management out', () => {
  const html = markup(<Sidebar />);
  expect(html).toContain('href="/dashboard"');
  expect(html).toContain('href="/analytics"');
  expect(html).toContain('href="/consorcio-pl"');
  for (const path of ['/partners', '/financeiro', '/admin', '/followup', '/settings/team']) {
    expect(html).not.toContain(`href="${path}"`);
  }
});

it('loads only own dashboard stats and PL sales, with calendar-month and seven-day arrivals', async () => {
  const html = textContent(await load(<DashboardPage />));
  expect(requests().sort()).toEqual(['/api/dashboard/stats', '/api/pl-sales']);
  expect(html).toContain('Meus leads');
  expect(html).toMatch(/Últimos 7 dias.*5/);
  expect(html).toMatch(/Leads neste mês.*8/);
  expect(html).toContain('atualmente atribuídos a você');
  expect(html).toContain('data de criação');
  expect(html).toContain('Conversão da minha carteira');
  expect(html).toContain('25%');
  expect(html).toContain('25.000,00');
  expect(html).toContain('100.000,00');
  for (const forbidden of ['987.654', 'Top Operadores', 'Outro vendedor', 'Origem dos Leads', 'Meta: 15%', 'SLA: 30min', 'Criar primeiro lead']) {
    expect(html).not.toContain(forbidden);
  }
  expect(get).toHaveBeenCalledWith('/api/pl-sales', expect.objectContaining({ params: { month: '2026-10', page: 1 } }));
});

it.each([
  [0, 0, 'Sem respostas suas no mês'],
  [2, 0, '0min'],
  [2, 12, '12min'],
])('distinguishes dashboard response samples %s and average %s', async (samples, average, expected) => {
  replies['/api/dashboard/stats'] = { ...stats, responseSamples: samples, avgResponseMinutes: average };
  const html = textContent(await load(<DashboardPage />));
  expect(html).toContain(expected);
  expect(html).toContain('Média da minha 1ª resposta');
  expect(html).toContain('mês atual');
});

it('shows an undefined goal and zero confirmed sales without substituting won lead estimates', async () => {
  replies['/api/pl-sales'] = { ...sales, summary: { total: '0.00', contracts: 0, target: null, remaining: null, percentage: null } };
  const html = textContent(await load(<DashboardPage />));
  expect(html).toContain('Não definida');
  expect(html).toContain('R$ 0,00');
  expect(html).not.toContain('987.654');
  expect(html).not.toContain('Defina uma meta');
  expect(html).not.toContain('Editar meta');
});

it('does not display fabricated sales or a goal when the sales request fails', async () => {
  replies['/api/pl-sales'] = new Error('unavailable');
  const html = textContent(await load(<DashboardPage />));
  expect(html).toContain('Não foi possível carregar suas vendas e meta');
  expect(html).not.toContain('25.000,00');
  expect(html).not.toContain('987.654');
});

it('renders personal analytics without team, attribution, financial estimates or general requests', async () => {
  const html = textContent(await load(<AnalyticsPage />));
  expect(html).toContain('Meus leads');
  expect(html).toContain('atualmente atribuídos a você');
  expect(html).toContain('data de criação');
  expect(html).toContain('Minha 1ª resposta');
  expect(html).toContain('Mediana');
  expect(html).toContain('Média');
  expect(html).toContain('Conversão no período');
  expect(html).toContain('Leads ganhos / (ganhos + perdidos)');
  expect(html).toContain('25.000,00');
  expect(html).toContain('100.000,00');
  for (const forbidden of ['performance da equipe', 'Performance por Responsável', 'por Atendente', 'Forecast de Receita', 'Ticket médio', '987.654', '329.218', 'Outro funil']) {
    expect(html).not.toContain(forbidden);
  }
  expect(requests().sort()).toEqual([
    '/api/analytics/conversion', '/api/analytics/first-response', '/api/analytics/funnel',
    '/api/analytics/overview', '/api/analytics/time-in-stage', '/api/analytics/timeseries', '/api/pl-sales',
  ]);
  expect(get).toHaveBeenCalledWith('/api/analytics/funnel', { params: { pipeline_id: PL_PIPELINE_ID } });
  expect(get).toHaveBeenCalledWith('/api/analytics/overview', { params: { from: '2026-10-01', to: '2026-10-19' } });
});

it('does not render another responder or invent response durations without own samples', async () => {
  replies['/api/analytics/first-response'] = { ...response, users: [{ id: 'someone-else', nome: 'Outro vendedor', answered: 5, median_seconds: 10, avg_seconds: 20 }] };
  const html = textContent(await load(<AnalyticsPage />));
  expect(html).toContain('Sem respostas suas no período');
  expect(html).not.toContain('Outro vendedor');
  expect(html).not.toContain('10s');
});

it.each([['dashboard', <DashboardPage />], ['analytics', <AnalyticsPage />]])('isolates %s cached data by account and restricted flag', async (_name, page) => {
  mockUser.pl_sales_only = false;
  replies['/api/dashboard/stats'] = { ...stats, totalLeads: 654321 };
  replies['/api/analytics/overview'] = { ...overview, total_leads: 654321 };
  await load(page);
  mockUser.pl_sales_only = true;
  expect(textContent(markup(page))).not.toContain('654.321');
  replies['/api/dashboard/stats'] = { ...stats, totalLeads: 123456 };
  replies['/api/analytics/overview'] = { ...overview, total_leads: 123456 };
  await load(page);
  mockUser.id = 'seller-two';
  const html = textContent(markup(page));
  expect(html).not.toContain('123.456');
  expect(html).not.toContain('25.000,00');
});

it.each([
  ['dashboard-stats', <DashboardPage />, '/api/dashboard/stats'],
  ['analytics-overview', <AnalyticsPage />, '/api/analytics/overview'],
  ['pl-sales', <DashboardPage />, '/api/pl-sales'],
])('refreshes %s when returning despite the global no-refetch setting', async (prefix, page, endpoint) => {
  client.setDefaultOptions({ queries: { retry: false, staleTime: 300_000, gcTime: Infinity, refetchOnMount: false } });
  await load(page);
  const query = client.getQueryCache().find({ queryKey: [prefix], exact: false });
  if (!query) throw new Error(`Missing report query: ${prefix}`);
  replies['/api/dashboard/stats'] = { ...stats, totalLeads: 1 };
  replies['/api/analytics/overview'] = { ...overview, total_leads: 1 };
  replies['/api/pl-sales'] = { ...sales, summary: { ...sales.summary, total: '12000.00' } };
  get.mockClear();
  const observer = new QueryObserver(client, query.options as UseQueryOptions);
  const unsubscribe = observer.subscribe(() => undefined);
  await query.promise;
  unsubscribe();
  expect(requests()).toContain(endpoint);
  if (prefix === 'pl-sales') {
    expect(query.state.data).toEqual(expect.objectContaining({ total: '12000.00' }));
  } else {
    expect(query.state.data).toEqual(expect.objectContaining(prefix === 'dashboard-stats' ? { totalLeads: 1 } : { total_leads: 1 }));
  }
});

it('preserves the general dashboard sections and requests for an unrestricted operator', async () => {
  mockUser.pl_sales_only = false;
  const html = textContent(await load(<DashboardPage />));
  expect(html).toContain('Top Operadores');
  expect(html).toContain('Origem dos Leads');
  expect(html).toContain('Valor ganho');
  expect(requests()).toContain('/api/dashboard/financeira');
  expect(requests()).toContain('/api/attribution/summary');
  expect(requests()).not.toContain('/api/pl-sales');
});

it('preserves team analytics and pipeline selection for management', async () => {
  Object.assign(mockUser, { role: 'GERENTE', pl_sales_only: false });
  const html = textContent(await load(<AnalyticsPage />));
  expect(html).toContain('Performance por Responsável');
  expect(html).toContain('Tempo de 1ª Resposta por Atendente');
  expect(html).toContain('Forecast de Receita');
  expect(html).toContain('Ticket médio');
  expect(requests()).toContain('/api/pipelines');
  expect(requests()).toContain('/api/analytics/performance');
  expect(requests()).toContain('/api/analytics/forecast');
  expect(requests()).not.toContain('/api/pl-sales');
});
