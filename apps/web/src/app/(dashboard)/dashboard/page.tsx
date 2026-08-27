'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import type { LucideIcon } from 'lucide-react';
import {
  Users,
  TrendingUp,
  Target,
  Clock,
  Trophy,
  Activity,
  BarChart3,
  ThermometerSun,
  AlertCircle,
  Plus,
  LineChart,
  MessageSquare,
  CheckSquare,
  DollarSign,
  Megaphone,
  HelpCircle,
  Scale,
  Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { AreaChart, type TrendPoint } from '@/components/dashboard/area-chart';
import { FunnelChart, type FunnelStage } from '@/components/dashboard/funnel-chart';
import { TemperatureDonut, type TempDatum } from '@/components/dashboard/temperature-donut';
import { AttributionDonut } from '@/components/dashboard/attribution-donut';
import { ActivityFeed, type ActivityItem } from '@/components/dashboard/activity-feed';
import {
  OperatorsLeaderboard,
  type OperatorRow,
} from '@/components/dashboard/operators-leaderboard';

interface DashboardStats {
  leadsByStage: FunnelStage[];
  totalLeads: number;
  leadsThisWeek: number;
  leadsLastWeek: number;
  conversionRate: number;
  avgResponseMinutes: number;
  wonValue: number;
  openConversations: number;
  pendingTasks: number;
  leadsTrend: TrendPoint[];
  leadsByTemp: TempDatum[];
  recentActivity: ActivityItem[];
  topOperators: OperatorRow[];
}

/**
 * `GET /api/dashboard/financeira`. Backend antigo nao tem a rota: a seção
 * inteira some em silencio (`retry: false` + render condicional), sem estragar
 * o resto da dashboard. Os valores vem de `Decimal` do Prisma, que pode chegar
 * serializado como string — por isso tudo passa por `numero()`.
 */
interface FinanceiraEtapa {
  stage: { id: string; nome: string; cor: string; ordem: number };
  count: number;
  total: number;
  probabilidade: number;
  ponderado: number;
}

interface FinanceiraOportunidade {
  lead_id: string;
  nome: string;
  valor: number;
  etapa: string;
  temperatura: string;
}

interface Financeira {
  previsao: { total_aberto: number; ponderado: number; por_etapa: FinanceiraEtapa[] };
  ganhos: {
    mes_atual: number;
    mes_anterior: number;
    quantidade_mes: number;
    ticket_medio: number;
  };
  top_oportunidades: FinanceiraOportunidade[];
}

function registro(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function numero(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function lerFinanceira(corpo: unknown): Financeira {
  const raiz = registro(corpo);
  const previsao = registro(raiz.previsao);
  const ganhos = registro(raiz.ganhos);
  const etapasBrutas = Array.isArray(previsao.por_etapa) ? previsao.por_etapa : [];
  const topBruto = Array.isArray(raiz.top_oportunidades) ? raiz.top_oportunidades : [];

  const por_etapa: FinanceiraEtapa[] = [];
  for (const bruto of etapasBrutas) {
    const linha = registro(bruto);
    const stage = registro(linha.stage);
    const id = texto(stage.id);
    if (id === '') continue;
    por_etapa.push({
      stage: {
        id,
        nome: texto(stage.nome),
        cor: texto(stage.cor),
        ordem: numero(stage.ordem),
      },
      count: numero(linha.count),
      total: numero(linha.total),
      probabilidade: numero(linha.probabilidade),
      ponderado: numero(linha.ponderado),
    });
  }

  const top_oportunidades: FinanceiraOportunidade[] = [];
  for (const bruto of topBruto) {
    const linha = registro(bruto);
    const lead_id = texto(linha.lead_id);
    if (lead_id === '') continue;
    top_oportunidades.push({
      lead_id,
      nome: texto(linha.nome),
      valor: numero(linha.valor),
      etapa: texto(linha.etapa),
      temperatura: texto(linha.temperatura),
    });
  }

  return {
    previsao: {
      total_aberto: numero(previsao.total_aberto),
      ponderado: numero(previsao.ponderado),
      por_etapa,
    },
    ganhos: {
      mes_atual: numero(ganhos.mes_atual),
      mes_anterior: numero(ganhos.mes_anterior),
      quantidade_mes: numero(ganhos.quantidade_mes),
      ticket_medio: numero(ganhos.ticket_medio),
    },
    top_oportunidades: top_oportunidades.slice(0, 5),
  };
}

/** Mesma paleta de temperatura da tabela de leads e do card do kanban. */
const TEMP_CORES: Record<string, { bg: string; fg: string; label: string }> = {
  FRIO: { bg: 'rgba(148,163,184,0.18)', fg: '#94a3b8', label: 'Frio' },
  MORNO: { bg: 'rgba(250,204,21,0.18)', fg: '#eab308', label: 'Morno' },
  QUENTE: { bg: 'rgba(249,115,22,0.18)', fg: '#f97316', label: 'Quente' },
  MUITO_QUENTE: { bg: 'rgba(239,68,68,0.18)', fg: '#ef4444', label: 'Muito quente' },
};

const AJUDA_FINANCEIRO =
  'O dinheiro que está em jogo no seu funil. "Em aberto" soma o valor estimado de todos os leads que ainda não foram ganhos nem perdidos. "Previsão ponderada" pesa cada um desses valores pela chance de fechar da etapa em que o lead está: um lead de R$ 10.000 numa etapa de 30% entra como R$ 3.000. "Ganhos no mês" é o que já fechou desde o dia 1º, comparado com o mês passado. "Ticket médio" é esse ganho dividido pelo número de negócios fechados no mês. A chance de fechar de cada etapa você define em Configurações › Pipeline; sem definir, o CRM usa a posição da etapa no funil. Todos os números desta seção são do funil ativo — por isso "Ganhos no mês" pode não bater com o "Valor ganho" lá em cima, que soma o CRM inteiro.';

const numberFmt = new Intl.NumberFormat('pt-BR');
const percentFmt = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const brlFmt = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

function formatMinutes(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function weeklyTrend(thisWeek: number, lastWeek: number): number | null {
  if (lastWeek <= 0) return thisWeek > 0 ? 100 : null;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
}

function SectionCard({
  title,
  icon: Icon,
  children,
  className = '',
  action,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 sm:p-5 transition-colors hover:border-[var(--border-strong)] ${className}`}
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <Icon size={16} style={{ color: 'var(--text-muted)' }} />
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warn';
}) {
  const color =
    tone === 'success' ? '#22c55e' : tone === 'warn' ? '#f59e0b' : 'var(--text-primary)';
  return (
    <div
      className="rounded-xl border p-4 flex items-center gap-3"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: 'var(--primary-subtle)' }}
      >
        <Icon size={18} style={{ color: 'var(--primary)' }} />
      </div>
      <div className="min-w-0">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p
          className="text-xl font-bold tracking-tight truncate"
          style={{ color, fontFeatureSettings: '"tnum"' }}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

/**
 * Delta dos ganhos em palavras. O `KpiCard` já desenha a seta (▲/▼) e a cor a
 * partir de `trend` — aqui só se decide QUANDO existe porcentagem: sem mês
 * anterior não há divisão possível ("novo"), e variação zero vira "igual" em
 * vez de um "+0%" que parece bug.
 */
function deltaGanhos(atual: number, anterior: number): { trend: number | null; sub: string } {
  if (anterior <= 0) {
    return atual > 0
      ? { trend: null, sub: 'novo — nada ganho no mês passado' }
      : { trend: null, sub: 'sem ganhos no mês passado' };
  }
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  if (pct === 0) return { trend: null, sub: '— igual ao mês passado' };
  // Um mês passado quase zerado gera porcentagem de quatro dígitos, que estoura
  // o card e não informa nada: "+12.400%" e "+80.000%" dizem a mesma coisa.
  if (pct > 999) return { trend: null, sub: '▲ muito acima do mês passado' };
  return { trend: pct, sub: 'vs mês passado' };
}

function AjudaFinanceiro() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Como funciona a seção Financeiro"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <p className="mb-1 text-xs font-semibold">Financeiro</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{AJUDA_FINANCEIRO}</p>
      </PopoverContent>
    </Popover>
  );
}

function TemperaturaChip({ temperatura }: { temperatura: string }) {
  const cor = TEMP_CORES[temperatura];
  if (!cor) return null;
  return (
    <span
      className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold shrink-0"
      style={{ background: cor.bg, color: cor.fg }}
    >
      {cor.label}
    </span>
  );
}

function FinanceiroSecao({ dados }: { dados: Financeira }) {
  const { trend, sub } = deltaGanhos(dados.ganhos.mes_atual, dados.ganhos.mes_anterior);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Financeiro
        </h2>
        <AjudaFinanceiro />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          icon={Wallet}
          label="Em aberto"
          value={brlFmt.format(dados.previsao.total_aberto)}
          sub="valor dos leads ainda em negociação"
        />
        <KpiCard
          icon={Scale}
          label="Previsão ponderada"
          value={brlFmt.format(dados.previsao.ponderado)}
          sub="soma dos valores pesados pela chance de fechar de cada etapa"
        />
        <KpiCard
          icon={Trophy}
          label="Ganhos no mês · neste funil"
          value={brlFmt.format(dados.ganhos.mes_atual)}
          trend={trend}
          sub={sub}
        />
        <KpiCard
          icon={DollarSign}
          label="Ticket médio"
          value={brlFmt.format(dados.ganhos.ticket_medio)}
          sub={`${numberFmt.format(dados.ganhos.quantidade_mes)} fechado(s) no mês`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Previsão por etapa" icon={BarChart3}>
          {dados.previsao.por_etapa.length === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              Nenhuma etapa em aberto neste pipeline.
            </p>
          ) : (
            <ul className="space-y-2">
              {dados.previsao.por_etapa.map((linha) => (
                <li key={linha.stage.id} className="flex items-center gap-3 text-sm">
                  <span
                    className="h-8 w-1 rounded-full shrink-0"
                    style={{ background: linha.stage.cor || 'var(--primary)' }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>
                      {linha.stage.nome}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {numberFmt.format(linha.count)} leads · {brlFmt.format(linha.total)} ·{' '}
                      {numberFmt.format(linha.probabilidade)}% de chance
                    </p>
                  </div>
                  <span
                    className="font-semibold shrink-0"
                    style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
                  >
                    {brlFmt.format(linha.ponderado)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Top oportunidades"
          icon={Target}
          action={
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              deste funil
            </span>
          }
        >
          {dados.top_oportunidades.length === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              Nenhum lead em aberto com valor estimado.
            </p>
          ) : (
            <ul className="space-y-1">
              {dados.top_oportunidades.map((op) => (
                <li key={op.lead_id}>
                  <Link
                    href={`/chat/${op.lead_id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>
                        {op.nome}
                      </p>
                      <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                        {op.etapa}
                      </p>
                    </div>
                    <TemperaturaChip temperatura={op.temperatura} />
                    <span
                      className="font-semibold shrink-0"
                      style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
                    >
                      {brlFmt.format(op.valor)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const queryClient = useQueryClient();

  const { data: stats, isLoading, isError } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const { data } = await api.get('/api/dashboard/stats');
      return data as DashboardStats;
    },
    refetchInterval: 30_000,
  });

  // A dashboard ainda não tem seletor de pipeline (o funil vem do pipeline
  // ativo do tenant). O slot na chave fica reservado para quando tiver — assim
  // o cache já nasce separado por pipeline e nada precisa ser reescrito aqui.
  const financeiraPipelineId: string | null = null;
  const { data: financeira } = useQuery<Financeira>({
    queryKey: ['dashboard-financeira', financeiraPipelineId],
    queryFn: async () => {
      const { data } = await api.get('/api/dashboard/financeira');
      return lerFinanceira(data);
    },
    // Backend antigo devolve 404: sem retry e sem mensagem de erro — a seção
    // simplesmente não aparece. O poll também para depois do erro: sem isso, um
    // backend sem a rota levaria um 404 a cada minuto, para sempre.
    retry: false,
    refetchInterval: (query) => (query.state.error ? false : 60_000),
  });

  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const scheduleInvalidate = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      }, 1500);
    };
    socket.on('lead:new-message', scheduleInvalidate);
    socket.on('lead:stage-changed', scheduleInvalidate);
    socket.on('lead:updated', scheduleInvalidate);
    return () => {
      socket.off('lead:new-message', scheduleInvalidate);
      socket.off('lead:stage-changed', scheduleInvalidate);
      socket.off('lead:updated', scheduleInvalidate);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [queryClient]);

  const trend = stats ? weeklyTrend(stats.leadsThisWeek, stats.leadsLastWeek) : null;

  if (!isLoading && stats && stats.totalLeads === 0) {
    return (
      <div className="p-4 sm:p-6 space-y-6">
        <PageHeader title="Dashboard" subtitle="Visão geral do funil em tempo real" live />
        <div
          className="rounded-xl border p-8 sm:p-12 flex flex-col items-center justify-center text-center"
          style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'var(--primary-subtle)' }}
          >
            <Users size={24} style={{ color: 'var(--primary)' }} />
          </div>
          <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Nenhum lead ainda
          </h3>
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
            Crie seu primeiro lead para começar a acompanhar o funil.
          </p>
          <Link
            href="/kanban"
            className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium transition-opacity hover:opacity-90"
            style={{ background: 'var(--primary)', color: 'white' }}
          >
            <Plus size={15} />
            Criar primeiro lead
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">
      <PageHeader title="Dashboard" subtitle="Visão geral do funil em tempo real" live />

      {isError && (
        <div
          className="rounded-lg border px-4 py-3 flex items-center gap-2 text-sm"
          style={{
            background: 'rgba(239,68,68,0.08)',
            borderColor: 'rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          <AlertCircle size={16} />
          Falha ao carregar estatísticas. Tentaremos novamente automaticamente.
        </div>
      )}

      {/* KPIs primários */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {isLoading ? (
          <>
            <KpiCard icon={Users} label="" value="" loading />
            <KpiCard icon={TrendingUp} label="" value="" loading />
            <KpiCard icon={Target} label="" value="" loading />
            <KpiCard icon={Clock} label="" value="" loading />
          </>
        ) : (
          <>
            <KpiCard
              icon={Users}
              label="Total de Leads"
              value={numberFmt.format(stats?.totalLeads ?? 0)}
              trend={trend}
              sub="vs. semana passada"
            />
            <KpiCard
              icon={TrendingUp}
              label="Leads esta semana"
              value={numberFmt.format(stats?.leadsThisWeek ?? 0)}
              sub={`Anterior: ${numberFmt.format(stats?.leadsLastWeek ?? 0)}`}
            />
            <KpiCard
              icon={Target}
              label="Taxa de conversão"
              value={percentFmt.format((stats?.conversionRate ?? 0) / 100)}
              sub="Meta: 15%"
            />
            <KpiCard
              icon={Clock}
              label="Tempo médio resposta"
              value={formatMinutes(stats?.avgResponseMinutes ?? 0)}
              sub="SLA: 30min"
            />
          </>
        )}
      </div>

      {/* Tendência + stats secundários */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Leads (últimos 14 dias)" icon={LineChart} className="lg:col-span-2">
          {isLoading ? (
            <Skeleton className="h-[180px] w-full" />
          ) : (
            <AreaChart data={stats?.leadsTrend ?? []} />
          )}
        </SectionCard>

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-3 sm:gap-4">
          {isLoading ? (
            <>
              <Skeleton className="h-[72px] w-full rounded-xl" />
              <Skeleton className="h-[72px] w-full rounded-xl" />
              <Skeleton className="h-[72px] w-full rounded-xl" />
            </>
          ) : (
            <>
              <MiniStat
                icon={MessageSquare}
                label="Conversas não lidas"
                value={numberFmt.format(stats?.openConversations ?? 0)}
                tone={stats && stats.openConversations > 0 ? 'warn' : 'default'}
              />
              <MiniStat
                icon={CheckSquare}
                label="Tarefas pendentes"
                value={numberFmt.format(stats?.pendingTasks ?? 0)}
              />
              <MiniStat
                icon={DollarSign}
                label="Valor ganho"
                value={brlFmt.format(stats?.wonValue ?? 0)}
                tone="success"
              />
            </>
          )}
        </div>
      </div>

      {/* Financeiro — some inteiro se a rota não existir no backend */}
      {financeira && <FinanceiroSecao dados={financeira} />}

      {/* Funil + Temperatura + Origem */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <SectionCard title="Funil de Vendas" icon={BarChart3} className="lg:col-span-2">
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <FunnelChart stages={stats?.leadsByStage ?? []} />
          )}
        </SectionCard>

        <SectionCard title="Distribuição por Temperatura" icon={ThermometerSun}>
          {isLoading ? (
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="h-[170px] w-[170px] rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (
            <TemperatureDonut data={stats?.leadsByTemp ?? []} />
          )}
        </SectionCard>

        <SectionCard title="Origem dos Leads" icon={Megaphone}>
          <AttributionDonut />
        </SectionCard>
      </div>

      {/* Atividade + Operadores */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Atividade Recente" icon={Activity}>
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <ActivityFeed items={stats?.recentActivity ?? []} />
          )}
        </SectionCard>

        <SectionCard title="Top Operadores" icon={Trophy}>
          {isLoading ? (
            <div className="space-y-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <OperatorsLeaderboard operators={stats?.topOperators ?? []} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
