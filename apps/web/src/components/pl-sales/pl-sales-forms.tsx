'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { amountInput, brl, saoPauloDate } from '@/lib/partners';
import { plCancelSchema, plDate, plError, plGoalSchema, plMonth, plSaleSchema, plSalesKey, type PlCandidate, type PlDashboard, type PlSale } from '@/lib/pl-sales';
import { Field, fieldClass } from '@/components/partners/partner-forms';
import { PlSaveForm, type PlFormActions } from './pl-save-form';
import { PlAmountInput } from './pl-amount-input';

export function PlSaleForm({ sale, data, tenant, userId, role, saved, refresh, onBusy }: {
  sale?: PlSale; data: PlDashboard; tenant: string; userId: string; role: string;
} & PlFormActions) {
  const members = data.members.filter(member => data.manager || member.id === userId);
  if (sale && !members.some(member => member.id === sale.seller_id)) members.push({id:sale.seller_id,name:`${sale.seller_name} (venda original)`});
  const [selected, setSelected] = useState<PlCandidate | null>(sale ? { id: sale.lead_id, nome: sale.customer_name, telefone: sale.customer_phone, responsavel_id: null } : null);
  const [seller, setSeller] = useState(() => sale ? members.find(member => member.id === sale.seller_id)?.id ?? '' : !data.manager ? members.find(member => member.id === userId)?.id ?? '' : '');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [contract, setContract] = useState(sale?.contract_number ?? '');
  const [amount, setAmount] = useState(sale ? brl(sale.amount) : '');
  const today = saoPauloDate();
  const [date, setDate] = useState(sale?.sold_on ?? (data.month === today.slice(0, 7) ? today : `${data.month}-01`));
  const [note, setNote] = useState(sale?.note ?? '');
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const candidates = useQuery({
    queryKey: [...plSalesKey(tenant, userId, role), 'candidates', debounced],
    queryFn: async ({ signal }) => (await api.get<PlCandidate[]>('/api/pl-sales/candidates', { params: { search: debounced }, signal })).data,
  });
  const options = candidates.data ?? [];
  const searching = search.trim() !== debounced || candidates.isFetching;

  async function save() {
    const body = plSaleSchema.parse({ lead_id: selected?.id ?? '', seller_id: seller, contract_number: contract, amount, sold_on: date, note });
    if (!members.some(member => member.id === body.seller_id)) throw new Error('Selecione uma pessoa ativa da equipe comercial.');
    if (data.sales.some(row => row.id !== sale?.id && row.contract_number.trim().toUpperCase() === body.contract_number)) throw new Error('Este contrato já está registrado, mesmo que tenha sido cancelado. Confira o número.');
    if (sale) await api.patch(`/api/pl-sales/${sale.id}`, { ...body, expectedVersion: sale.version });
    else await api.post('/api/pl-sales', body);
    await saved();
  }

  return <PlSaveForm save={save} refresh={refresh} onBusy={onBusy} versioned={!!sale} disabled={!members.length} label={sale ? 'Salvar correção' : 'Registrar venda'}>
    <Field label="Buscar cliente no Consórcio PL"><input className={fieldClass} maxLength={150} value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome ou telefone" /></Field>
    <Field label="Cliente / lead"><select required className={fieldClass} value={selected?.id ?? ''} onChange={event => {
      const candidate = options.find(item => item.id === event.target.value) ?? (selected?.id === event.target.value ? selected : null);
      setSelected(candidate);
      if (data.manager && !seller && candidate?.responsavel_id && members.some(member => member.id === candidate.responsavel_id)) setSeller(candidate.responsavel_id);
    }}>
      <option value="">Selecione um cliente</option>
      {selected && !options.some(item => item.id === selected.id) && <option value={selected.id}>{selected.nome} · {selected.telefone}</option>}
      {options.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.nome} · {candidate.telefone}</option>)}
    </select></Field>
    {searching && <p role="status" className="text-xs text-muted-foreground">Buscando clientes…</p>}
    {candidates.isError && <p role="alert" className="text-sm text-destructive">{plError(candidates.error)} <button type="button" className="underline" onClick={() => void candidates.refetch()}>Tentar novamente</button></p>}
    {!searching && !candidates.isError && !options.length && <p className="text-sm text-muted-foreground">Nenhum cliente encontrado no Consórcio PL{data.manager ? '.' : ' sob sua responsabilidade.'} Busque por nome ou telefone.</p>}
    <p className="text-xs text-muted-foreground">Até 30 resultados por busca. {selected ? `Selecionado: ${selected.nome} · ${selected.telefone}.` : 'Selecione um cliente existente no funil.'}</p>
    <Field label="Vendedor responsável"><select required className={fieldClass} disabled={!data.manager} value={seller} onChange={event => setSeller(event.target.value)}>
      <option value="">Selecione o vendedor</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select></Field>
    {!members.length && <p role="alert" className="text-sm text-destructive">Nenhum vendedor comercial ativo disponível para registrar vendas.</p>}

    <Field label="Número do contrato"><input required maxLength={120} className={fieldClass} value={contract} onChange={event => setContract(event.target.value)} placeholder="Número único do contrato" /></Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Crédito contratado (R$)"><PlAmountInput value={amount} onChange={setAmount} /></Field>
      <Field label="Data de fechamento"><input required type="date" min="1900-01-01" max={today} className={fieldClass} value={date} onChange={event => setDate(event.target.value)} /></Field>
    </div>
    {date && date.slice(0, 7) !== data.month && <p className="text-sm text-muted-foreground">Esta venda será contabilizada em {plMonth(date.slice(0, 7))}. Selecione esse mês no relatório para consultá-la.</p>}
    <Field label="Observação / motivo da correção"><textarea maxLength={3000} rows={3} className={fieldClass} value={note} onChange={event => setNote(event.target.value)} /></Field>
    <p className="text-xs text-muted-foreground">Informe o valor do crédito contratado, não a comissão. {sale ? 'A correção substitui os dados desta venda e fica no histórico.' : 'O registro conta uma vez nos resultados do mês de fechamento.'}</p>
  </PlSaveForm>;
}

export function PlGoalForm({ data, initialOwner = 'team', saved, refresh, onBusy }: { data: PlDashboard; initialOwner?: string } & PlFormActions) {
  const [owner, setOwner] = useState(initialOwner);
  const [amount, setAmount] = useState(() => { const goal = data.goals.find(item => item.owner_key === initialOwner); return goal ? amountInput(goal.amount) : ''; });
  const goal = data.goals.find(item => item.owner_key === owner);
  async function save() {
    if (owner !== 'team' && !data.members.some(member => member.id === owner)) throw new Error('Selecione um vendedor ativo.');
    const body = plGoalSchema.parse({ amount, expectedVersion: goal?.version ?? 0 });
    await api.put(`/api/pl-sales/goals/${data.month}/${owner}`, body);
    await saved();
  }
  return <PlSaveForm save={save} refresh={refresh} onBusy={onBusy} label="Salvar meta">
    <p className="text-sm">Meta de crédito contratado em <strong>{plMonth(data.month)}</strong>.</p>
    <Field label="Meta da equipe ou individual"><select className={fieldClass} value={owner} onChange={event => {
      setOwner(event.target.value);
      const selected = data.goals.find(item => item.owner_key === event.target.value);
      setAmount(selected ? amountInput(selected.amount) : '');
    }}><option value="team">Equipe PL</option>{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>
    <p className="text-sm text-muted-foreground">{goal ? `Meta atual: ${brl(goal.amount)}.` : 'Nenhuma meta definida para esta seleção.'}</p>
    <Field label="Meta em crédito contratado (R$)"><input required inputMode="decimal" className={fieldClass} value={amount} onChange={event => setAmount(event.target.value)} placeholder="Informe a meta em reais" /></Field>
    <p className="text-xs text-muted-foreground">A meta da equipe é independente das metas individuais. Zero é uma meta explícita de R$ 0,00; um campo vazio não define uma meta.</p>
  </PlSaveForm>;
}

export function PlCancelForm({ sale, saved, refresh, onBusy }: { sale: PlSale } & PlFormActions) {
  const [reason, setReason] = useState('');
  return <PlSaveForm destructive label="Confirmar cancelamento" refresh={refresh} onBusy={onBusy} save={async () => {
    const body = plCancelSchema.parse({ reason, expectedVersion: sale.version });
    await api.post(`/api/pl-sales/${sale.id}/cancel`, body);
    await saved();
  }}>
    <div className="space-y-1 rounded-lg bg-muted p-3 text-sm"><p className="font-semibold">{sale.customer_name} · Contrato {sale.contract_number}</p><p>{sale.seller_name} · {plDate(sale.sold_on)}</p><p>Crédito contratado: {brl(sale.amount)}</p></div>
    <p className="text-sm text-muted-foreground">A venda deixará de contar nos totais e no ranking. O registro e o motivo permanecerão no histórico. O cancelamento não pode ser desfeito nesta tela.</p>
    <Field label="Motivo do cancelamento"><textarea required minLength={3} maxLength={1000} rows={3} className={fieldClass} value={reason} onChange={event => setReason(event.target.value)} /></Field>
  </PlSaveForm>;
}
