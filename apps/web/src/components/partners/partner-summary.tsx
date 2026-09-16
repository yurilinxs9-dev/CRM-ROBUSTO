'use client';
import { brl, type PartnerDashboard } from '@/lib/partners';

export function PartnerSummary({ data }: { data: PartnerDashboard }) {
  const s = data.summary;
  const max = Math.max(1, ...data.daily.map(d => Number(d.total)));
  const maxAccumulated = Math.max(1, Number(s.total));
  const points = data.daily.map((d, i) => `${35 + i * (730 / Math.max(1, data.daily.length - 1))},${170 - Number(d.accumulated) / maxAccumulated * 135}`).join(' ');
  const metrics = [
    { label: 'Vendas no mês', value: brl(s.total), hint: 'Total registrado pelos parceiros' },
    { label: 'Meta do mês', value: s.target === null ? 'Não definida' : brl(s.target), hint: s.percentage === null ? 'Defina uma meta para acompanhar' : `${s.percentage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta atingida` },
    { label: Number(s.excess) > 0 ? 'Acima da meta' : 'Falta para a meta', value: s.remaining === null ? '—' : brl(Number(s.excess) > 0 ? s.excess : s.remaining), hint: s.days_remaining ? `${s.days_remaining} dias corridos disponíveis` : 'Mês encerrado' },
    { label: 'Necessário por dia', value: s.required_per_day === null ? '—' : brl(s.required_per_day), hint: 'Dias corridos, incluindo hoje no mês atual' },
  ];
  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(m => <div key={m.label} className="rounded-xl border bg-card p-5"><p className="text-sm text-muted-foreground">{m.label}</p><p className="mt-3 break-words text-2xl font-semibold tracking-tight">{m.value}</p><p className="mt-2 text-xs text-muted-foreground">{m.hint}</p></div>)}</div>
    {s.percentage !== null && <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Meta mensal atingida" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, s.percentage)}><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.max(0, s.percentage))}%` }} /></div>}
    <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-muted-foreground">
      {data.month === data.today.slice(0, 7) && <span>Vendas de hoje: <strong className="text-foreground">{brl(s.today_total)}</strong></span>}
      <span>Parceiros ativos: <strong className="text-foreground">{s.active_partners}</strong></span>
      <span>Com vendas no mês: <strong className="text-foreground">{s.producing_partners}</strong></span>
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
      <section className="rounded-xl border bg-card p-5"><h2 className="font-semibold">Ritmo de vendas</h2><p className="mt-1 text-sm text-muted-foreground">Valores registrados por dia. Passe sobre uma barra para ver o total.</p>
        <div className="mt-5 flex h-40 items-end gap-1" aria-label="Vendas por dia">{data.daily.map(d => <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.date.split('-').reverse().join('/')}: ${brl(d.total)}`}><div className="min-h-[2px] rounded-t bg-emerald-500/80" style={{ height: `${Number(d.total) / max * 100}%` }} /><span className="mt-2 text-center text-[9px] text-muted-foreground">{d.date.slice(8)}</span></div>)}</div>
        <h3 className="mt-7 text-sm font-medium">Acumulado do mês</h3><svg viewBox="0 0 800 200" className="mt-2 w-full" role="img" aria-label={`Acumulado do mês: ${brl(s.total)}`}><line x1="35" y1="170" x2="765" y2="170" stroke="currentColor" opacity="0.15" /><polyline points={points} fill="none" stroke="currentColor" className="text-emerald-500" strokeWidth="3" /><text x="35" y="194" fontSize="12" fill="currentColor">Dia 1</text><text x="765" y="194" textAnchor="end" fontSize="12" fill="currentColor">{brl(s.total)}</text></svg>
      </section>
      <section className="rounded-xl border bg-card p-5"><h2 className="font-semibold">Parceiros em destaque</h2><p className="mt-1 text-sm text-muted-foreground">Ranking de vendas do mês selecionado</p>
        {data.ranking.filter(p => Number(p.total) > 0).length === 0 ? <p className="py-14 text-center text-sm text-muted-foreground">O ranking aparece com as primeiras vendas.</p> : <ol className="mt-5 space-y-4">{data.ranking.filter(p => Number(p.total) > 0).slice(0, 10).map((p, i) => <li className="flex items-center gap-3" key={p.id}><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${i < 3 ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>{i + 1}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{i === 0 ? 'Maior produção do mês' : `Posição ${i + 1}`}</p></div><span className="text-sm font-semibold">{brl(p.total)}</span></li>)}</ol>}
      </section>
    </div>
    <p className="text-xs text-muted-foreground">Acompanhamento das vendas dos parceiros. A produção declarada no formulário de cadastro não entra nestes totais. Sem lançamento significa sem registro, não necessariamente ausência de vendas.</p>
  </div>;
}
