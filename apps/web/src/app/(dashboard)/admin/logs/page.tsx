'use client';

import { useQuery } from '@tanstack/react-query';
import { ScrollText, LogIn, Webhook, ServerCrash } from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

interface AuditLog {
  id: string;
  admin_user_id: string;
  action: string;
  target_tenant_id: string | null;
  target_user_id: string | null;
  /** Json livre do Prisma — nunca `any`, só desconhecido até virar string. */
  detail: unknown;
  ip: string | null;
  created_at: string;
}

interface WebhookErrorLog {
  id: string;
  event: string;
  error: string | null;
  tenant_id: string | null;
  created_at: string;
}

interface ApiErrorLog {
  id: string;
  tenant_id: string;
  method: string;
  path: string;
  status_code: number;
  created_at: string;
}

interface Logs {
  admin_audit: AuditLog[];
  login_attempts: AuditLog[];
  webhook_errors: WebhookErrorLog[];
  api_errors: ApiErrorLog[];
}

const dt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
const when = (iso: string) => dt.format(new Date(iso));
/** uuid inteiro estoura a coluna; o valor cheio fica no title. */
const shortId = (id: string) => id.slice(0, 8);

/** `detail` é Json livre: cabe compacto na célula, inteiro no title. */
function compactJson(detail: unknown): { short: string; full: string } | null {
  if (detail === null || detail === undefined) return null;
  const full = JSON.stringify(detail);
  if (!full || full === '{}' || full === 'null') return null;
  return { short: full.length > 48 ? `${full.slice(0, 48)}…` : full, full };
}

function statusColor(code: number) {
  return code >= 500 ? '#ef4444' : '#f59e0b';
}

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof ScrollText;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
      <div
        className="flex items-center gap-2 px-4 py-3"
        style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-default)' }}
      >
        <Icon size={16} style={{ color: 'var(--primary)' }} />
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h4>
        <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>{count}</span>
      </div>
      {count === 0 ? (
        <p className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Nenhum registro.</p>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  );
}

function Head({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
        {cols.map((h) => (
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
  );
}

const rowStyle = { borderBottom: '1px solid var(--border-default)' };
const cell = 'px-3 py-2 align-top';

export default function AdminLogsPage() {
  const { data, isLoading, isError } = useQuery<Logs>({
    queryKey: ['admin-logs'],
    queryFn: async () => (await api.get<Logs>('/api/platform-admin/logs')).data,
    refetchInterval: 60_000,
  });

  if (isError) {
    return (
      <div
        className="rounded-xl border border-dashed p-8 text-center text-sm"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
      >
        Não foi possível carregar os logs.
      </div>
    );
  }

  if (isLoading || !data) {
    return <div className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44 w-full rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-5">
      <Section icon={ScrollText} title="Auditoria admin" count={data.admin_audit.length}>
        <table className="w-full text-sm">
          <Head cols={['Data/hora', 'Ação', 'Alvo', 'Detalhe', 'IP']} />
          <tbody>
            {data.admin_audit.map((r) => {
              const detail = compactJson(r.detail);
              return (
                <tr key={r.id} className="hover:bg-accent/40 transition-colors" style={rowStyle}>
                  <td className={`${cell} whitespace-nowrap tabular-nums`} style={{ color: 'var(--text-secondary)' }}>{when(r.created_at)}</td>
                  <td className={`${cell} whitespace-nowrap font-medium`} style={{ color: 'var(--text-primary)' }}>{r.action}</td>
                  <td className={cell} style={{ color: 'var(--text-secondary)' }}>
                    {r.target_tenant_id || r.target_user_id ? (
                      <div className="space-y-0.5 text-xs">
                        {r.target_tenant_id && (
                          <div className="whitespace-nowrap" title={r.target_tenant_id}>cliente {shortId(r.target_tenant_id)}</div>
                        )}
                        {r.target_user_id && (
                          <div className="whitespace-nowrap" title={r.target_user_id}>usuário {shortId(r.target_user_id)}</div>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td className={`${cell} text-xs`} style={{ color: 'var(--text-muted)' }}>
                    {detail ? (
                      <span className="block max-w-[280px] truncate font-mono" title={detail.full}>{detail.short}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={`${cell} whitespace-nowrap text-xs`} style={{ color: 'var(--text-muted)' }}>{r.ip ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section icon={LogIn} title="Tentativas de login" count={data.login_attempts.length}>
        <table className="w-full text-sm">
          <Head cols={['Data/hora', 'Ação', 'IP']} />
          <tbody>
            {data.login_attempts.map((r) => {
              const failed = r.action === 'login_failed';
              return (
                <tr key={r.id} className="hover:bg-accent/40 transition-colors" style={rowStyle}>
                  <td className={`${cell} whitespace-nowrap tabular-nums`} style={{ color: 'var(--text-secondary)' }}>{when(r.created_at)}</td>
                  <td className={`${cell} whitespace-nowrap`}>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: failed ? '#ef4444' : '#22c55e' }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: failed ? '#ef4444' : '#22c55e' }} />
                      {failed ? 'login_failed' : 'login_success'}
                    </span>
                  </td>
                  <td className={`${cell} whitespace-nowrap text-xs`} style={{ color: 'var(--text-muted)' }}>{r.ip ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section icon={Webhook} title="Erros de webhook" count={data.webhook_errors.length}>
        <table className="w-full text-sm">
          <Head cols={['Data/hora', 'Evento', 'Erro', 'Cliente']} />
          <tbody>
            {data.webhook_errors.map((r) => (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors" style={rowStyle}>
                <td className={`${cell} whitespace-nowrap tabular-nums`} style={{ color: 'var(--text-secondary)' }}>{when(r.created_at)}</td>
                <td className={`${cell} whitespace-nowrap font-medium`} style={{ color: 'var(--text-primary)' }}>{r.event}</td>
                <td className={cell} style={{ color: '#ef4444' }}>
                  <span className="block max-w-[420px] truncate text-xs" title={r.error ?? ''}>{r.error ?? '—'}</span>
                </td>
                <td className={`${cell} whitespace-nowrap text-xs`} style={{ color: 'var(--text-muted)' }}>
                  {r.tenant_id ? <span title={r.tenant_id}>{shortId(r.tenant_id)}</span> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section icon={ServerCrash} title="Erros de API" count={data.api_errors.length}>
        <table className="w-full text-sm">
          <Head cols={['Data/hora', 'Método', 'Caminho', 'Status', 'Cliente']} />
          <tbody>
            {data.api_errors.map((r) => (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors" style={rowStyle}>
                <td className={`${cell} whitespace-nowrap tabular-nums`} style={{ color: 'var(--text-secondary)' }}>{when(r.created_at)}</td>
                <td className={`${cell} whitespace-nowrap text-xs font-semibold`} style={{ color: 'var(--text-secondary)' }}>{r.method}</td>
                <td className={cell} style={{ color: 'var(--text-primary)' }}>
                  <span className="block max-w-[420px] truncate font-mono text-xs" title={r.path}>{r.path}</span>
                </td>
                <td className={`${cell} whitespace-nowrap tabular-nums font-medium`} style={{ color: statusColor(r.status_code) }}>{r.status_code}</td>
                <td className={`${cell} whitespace-nowrap text-xs`} style={{ color: 'var(--text-muted)' }}>
                  <span title={r.tenant_id}>{shortId(r.tenant_id)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
