import { Target } from 'lucide-react';
import { brl } from '@/lib/partners';
import { plPercentage, plRanking, type PlDashboard } from '@/lib/pl-sales';
import { Button } from '@/components/ui/button';

export function PlSalesOverview({ data, editGoal }: { data: PlDashboard; editGoal: (owner: string) => void }) {
  const { summary } = data;
  const ranking = plRanking(data);
  const percentage = summary.percentage !== null && Number.isFinite(summary.percentage) ? summary.percentage : null;
  const cards = [
    { label: 'Crédito contratado', value: brl(summary.total), detail: 'Vendas ativas no mês' },
    { label: 'Contratos ativos', value: String(summary.contracts), detail: 'Cancelados não entram no resultado' },
    { label: data.manager ? 'Meta da equipe' : 'Sua meta', value: summary.target === null ? 'Não definida' : brl(summary.target), detail: 'Crédito contratado no mês' },
    { label: 'Falta para a meta', value: summary.remaining === null ? '—' : brl(summary.remaining), detail: summary.target === null ? 'Defina uma meta para acompanhar' : Number(summary.target) === 0 ? 'Meta definida em R$ 0,00' : 'Considera somente vendas ativas' },
  ];
  return <>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(card => <article key={card.label} className="min-w-0 rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">{card.label}</p><p className="mt-2 break-words text-2xl font-semibold tracking-tight">{card.value}</p><p className="mt-2 text-xs text-muted-foreground">{card.detail}</p>
    </article>)}</div>
    <section aria-label="Progresso da meta mensal" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{summary.target === null ? 'Meta ainda não definida' : percentage === null ? 'Meta zero: percentual não se aplica' : `${plPercentage(percentage)} da meta alcançada`}</p>
        {data.manager && <Button size="sm" variant="outline" onClick={() => editGoal('team')}><Target className="mr-2 h-4 w-4" />{summary.target === null ? 'Definir meta da equipe' : 'Editar meta da equipe'}</Button>}
      </div>
      {percentage !== null && <div role="progressbar" aria-label="Percentual da meta alcançada" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, percentage))} aria-valuetext={`${plPercentage(percentage)} da meta`} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} /></div>}
      <p className="text-xs text-muted-foreground">{data.manager ? 'Metas da equipe e individuais são definidas separadamente.' : 'Este relatório mostra somente suas vendas e sua meta individual.'} Todos os valores representam crédito contratado em reais.</p>
    </section>
    <section className="space-y-3">
      <div><h2 className="font-semibold">{data.manager ? 'Ranking de vendas' : 'Seu desempenho'}</h2><p className="mt-1 text-sm text-muted-foreground">{data.manager ? 'Equipe comercial, incluindo quem ainda não vendeu neste mês.' : 'Contratos ativos no mês selecionado.'}</p></div>
      {!ranking.length ? <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Nenhum vendedor elegível ou venda ativa neste mês.</div> : <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm"><thead className="bg-muted/50 text-muted-foreground"><tr>{['Vendedor', 'Crédito contratado', 'Contratos', 'Meta individual', 'Progresso', ...(data.manager ? ['Ações'] : [])].map(label => <th key={label} scope="col" className="whitespace-nowrap p-4 font-medium">{label}</th>)}</tr></thead>
          <tbody>{ranking.map((row, index) => {
            const eligible = data.members.some(member => member.id === row.seller_id);
            const target = row.target === null ? null : Number(row.target);
            return <tr key={row.seller_id} className="border-t">
              <td className="p-4"><p className="font-medium">{data.manager && <span className="mr-2 text-muted-foreground">{index + 1}.</span>}{row.seller_name}</p>{!eligible && <p className="text-xs text-muted-foreground">Fora da equipe comercial ativa</p>}</td>
              <td className="whitespace-nowrap p-4 font-semibold">{brl(row.amount)}</td><td className="p-4">{row.contracts}{row.contracts === 0 && <p className="whitespace-nowrap text-xs text-muted-foreground">Sem vendas no mês</p>}</td>
              <td className="whitespace-nowrap p-4">{row.target === null ? 'Não definida' : brl(row.target)}</td>
              <td className="whitespace-nowrap p-4">{target === null ? 'Sem meta' : target === 0 ? 'Meta zero · sem percentual' : plPercentage(Number(row.amount) / target * 100)}</td>
              {data.manager && <td className="p-4">{eligible && <Button variant="ghost" size="sm" aria-label={`${row.target === null ? 'Definir' : 'Editar'} meta de ${row.seller_name}`} onClick={() => editGoal(row.seller_id)}>{row.target === null ? 'Definir meta' : 'Editar meta'}</Button>}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>}
    </section>
  </>;
}
