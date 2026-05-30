'use client';

import { useQuery } from '@tanstack/react-query';
import { Database, HardDrive, Webhook, ShieldAlert, Info, AlertTriangle, Lightbulb } from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

interface Health {
  db: { leads: number; messages: number; leads_24h: number; messages_24h: number };
  storage: { media_bytes: number; media_gb: number; limit_gb: number; used_pct: number };
  webhooks_24h: { total: number; errors: number; error_rate: number };
  security_24h: { failed_logins: number };
  tips: { level: string; text: string }[];
}

const n = new Intl.NumberFormat('pt-BR');

function Card({ icon: Icon, title, children }: { icon: typeof Database; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} style={{ color: 'var(--primary)' }} />
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h4>
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span style={{ color: 'var(--text-muted)' }}>{k}</span>
      <span className="font-medium tabular-nums" style={{ color: warn ? '#f59e0b' : 'var(--text-primary)' }}>{v}</span>
    </div>
  );
}

export default function AdminHealthPage() {
  const { data, isLoading } = useQuery<Health>({
    queryKey: ['admin-health'],
    queryFn: async () => (await api.get<Health>('/api/platform-admin/health')).data,
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <div className="grid gap-4 sm:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 w-full rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card icon={Database} title="Banco de dados">
          <Row k="Leads" v={n.format(data.db.leads)} />
          <Row k="Mensagens" v={n.format(data.db.messages)} />
          <Row k="Leads (24h)" v={`+${n.format(data.db.leads_24h)}`} />
          <Row k="Msgs (24h)" v={`+${n.format(data.db.messages_24h)}`} />
        </Card>

        <Card icon={HardDrive} title="Storage de mídia">
          <Row k="Uso" v={`${data.storage.media_gb} GB`} warn={data.storage.used_pct > 80} />
          <Row k="Limite" v={`${data.storage.limit_gb} GB`} />
          <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-surface-3)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(data.storage.used_pct, 100)}%`, background: data.storage.used_pct > 80 ? '#f59e0b' : 'var(--primary)' }} />
          </div>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{data.storage.used_pct}% usado · cleanup auto 30d</p>
        </Card>

        <Card icon={Webhook} title="Webhooks (24h)">
          <Row k="Total" v={n.format(data.webhooks_24h.total)} />
          <Row k="Erros" v={n.format(data.webhooks_24h.errors)} warn={data.webhooks_24h.error_rate > 5} />
          <Row k="Taxa de erro" v={`${data.webhooks_24h.error_rate}%`} warn={data.webhooks_24h.error_rate > 5} />
        </Card>

        <Card icon={ShieldAlert} title="Segurança (24h)">
          <Row k="Logins falhos" v={n.format(data.security_24h.failed_logins)} warn={data.security_24h.failed_logins > 20} />
        </Card>
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb size={16} style={{ color: 'var(--primary)' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Dicas para operação escalável e saudável</h4>
        </div>
        <ul className="space-y-2">
          {data.tips.map((t, i) => {
            const Icon = t.level === 'warning' ? AlertTriangle : Info;
            const color = t.level === 'warning' ? '#f59e0b' : 'var(--text-muted)';
            return (
              <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Icon size={15} style={{ color, marginTop: 2 }} className="shrink-0" />
                <span>{t.text}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Métricas de host (CPU/RAM/disco da VPS): monitore pelo Uptime Kuma em http://187.127.11.117:3002.
        </p>
      </div>
    </div>
  );
}
