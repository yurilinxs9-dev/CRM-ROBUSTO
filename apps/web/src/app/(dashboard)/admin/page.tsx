'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, Users, Contact, MessageSquare, Smartphone, Wifi } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { format, formatDistanceToNowStrict, isValid } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

interface Stats {
  tenants: number;
  users: number;
  leads: number;
  messages: number;
  instances: number;
  active_instances: number;
}

const numberFmt = new Intl.NumberFormat('pt-BR');

// ---- Saúde das instâncias ---------------------------------------------------

type InstanceProvider = 'uazapi' | 'evolution' | 'legado';

interface InstanceHealthRow {
  tenant: string;
  nome: string;
  provider: InstanceProvider;
  status: string;
  ultimo_check: string | null;
  caida_desde: string | null;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function providerDe(v: unknown): InstanceProvider {
  return v === 'uazapi' || v === 'evolution' ? v : 'legado';
}

/** Backend velho (sem a rota) cai no `retry:false`; corpo estranho vira lista vazia. */
function normalizarInstancias(payload: unknown): InstanceHealthRow[] {
  const bruto = (payload as { instancias?: unknown } | null | undefined)?.instancias;
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => ({
      tenant: texto(i.tenant),
      nome: texto(i.nome),
      provider: providerDe(i.provider),
      status: texto(i.status),
      ultimo_check: textoOuNulo(i.ultimo_check),
      caida_desde: textoOuNulo(i.caida_desde),
    }));
}

/** "há 3 minutos" — "—" quando não houve checagem ou a data veio inválida. */
function checagemRelativa(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!isValid(d)) return '—';
  return `há ${formatDistanceToNowStrict(d, { locale: ptBR })}`;
}

function dataCurta(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!isValid(d)) return '—';
  return format(d, 'dd/MM HH:mm');
}

const CORES_STATUS: Record<string, { fundo: string; texto: string }> = {
  open: { fundo: 'rgba(34,197,94,0.15)', texto: '#22c55e' },
  connecting: { fundo: 'rgba(245,158,11,0.15)', texto: '#f59e0b' },
  disconnected: { fundo: 'rgba(239,68,68,0.15)', texto: '#ef4444' },
  close: { fundo: 'rgba(239,68,68,0.15)', texto: '#ef4444' },
};

const CINZA = { fundo: 'rgba(107,114,128,0.15)', texto: '#6b7280' };

function StatusChip({ status }: { status: string }) {
  const cor = CORES_STATUS[status.toLowerCase()] ?? CINZA;
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ background: cor.fundo, color: cor.texto }}
    >
      {status || 'desconhecido'}
    </span>
  );
}

function InstancesSection({ instancias }: { instancias: InstanceHealthRow[] }) {
  const caidas = instancias.filter((i) => i.caida_desde !== null).length;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Instâncias
        </h3>
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
          style={
            caidas > 0
              ? { background: 'rgba(239,68,68,0.15)', color: '#ef4444' }
              : { background: 'rgba(34,197,94,0.15)', color: '#22c55e' }
          }
        >
          {caidas > 0 ? `${numberFmt.format(caidas)} caída(s)` : 'todas conectadas'}
        </span>
      </div>

      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-default)' }}>
                {['Tenant', 'Instância', 'Status', 'Última checagem', 'Caída desde'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {instancias.map((i, idx) => (
                <tr key={`${i.tenant}|${i.nome}|${idx}`} style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{i.tenant || '—'}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                    <div className="truncate max-w-[220px]">{i.nome || '—'}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{i.provider}</div>
                  </td>
                  <td className="px-3 py-2"><StatusChip status={i.status} /></td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                    {checagemRelativa(i.ultimo_check)}
                  </td>
                  <td
                    className="px-3 py-2 whitespace-nowrap tabular-nums"
                    style={{ color: i.caida_desde ? '#ef4444' : 'var(--text-muted)' }}
                  >
                    {dataCurta(i.caida_desde)}
                  </td>
                </tr>
              ))}
              {instancias.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhuma instância monitorada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div
      className="rounded-xl border p-4 sm:p-5"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'var(--primary-subtle)' }}>
          <Icon size={16} style={{ color: 'var(--primary)' }} />
        </div>
      </div>
      <p className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}>
        {value}
      </p>
    </div>
  );
}

export default function AdminOverviewPage() {
  const { data, isLoading } = useQuery<Stats>({
    queryKey: ['admin-stats'],
    queryFn: async () => (await api.get<Stats>('/api/platform-admin/stats')).data,
    refetchInterval: 30_000,
  });

  // Saúde das instâncias: backend sem a rota → seção some, sem crash e sem retry.
  const { data: instancias } = useQuery<InstanceHealthRow[]>({
    queryKey: ['admin-instances-health'],
    queryFn: async () => normalizarInstancias((await api.get<unknown>('/api/platform-admin/instances-health')).data),
    refetchInterval: (q) => (q.state.error ? false : 60_000),
    retry: false,
  });

  return (
    <div className="space-y-6">
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          <StatCard icon={Building2} label="Clientes (tenants)" value={numberFmt.format(data?.tenants ?? 0)} />
          <StatCard icon={Users} label="Usuários" value={numberFmt.format(data?.users ?? 0)} />
          <StatCard icon={Contact} label="Leads" value={numberFmt.format(data?.leads ?? 0)} />
          <StatCard icon={MessageSquare} label="Mensagens" value={numberFmt.format(data?.messages ?? 0)} />
          <StatCard icon={Smartphone} label="Instâncias" value={numberFmt.format(data?.instances ?? 0)} />
          <StatCard icon={Wifi} label="Instâncias ativas" value={numberFmt.format(data?.active_instances ?? 0)} />
        </div>
      )}

      {instancias !== undefined && <InstancesSection instancias={instancias} />}
    </div>
  );
}
