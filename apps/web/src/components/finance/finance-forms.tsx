'use client';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { brl, parsePartnerAmount, amountInput } from '@/lib/partners';
import { financeError, humanDate, type FinanceCall, type FinanceInstallment, type FinanceRule, type FinanceSale } from '@/lib/finance';
export const financeInput = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const Field = ({ label, children }: {
    label: string;
    children: ReactNode;
}) => <label className="block space-y-1.5 text-sm font-medium"><span>{label}</span>{children}</label>;
export type FinanceEditor = {
    kind: 'manual';
    sale?: FinanceSale;
} | {
    kind: 'installment';
    row: FinanceInstallment;
} | {
    kind: 'rule';
    rule: FinanceRule;
} | {
    kind: 'cancel' | 'reconcile';
    sale: FinanceSale;
};
export function FinanceModal({ editor, call, today, close, saved }: {
    editor: FinanceEditor;
    call: FinanceCall;
    today: string;
    close: () => void;
    saved: () => Promise<void>;
}) {
    const busy = useRef(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    async function save(work: () => Promise<unknown>) { if (busy.current)
        return; busy.current = true; setSaving(true); setError(''); try {
        await work();
        await saved();
    }
    catch (e) {
        setError(financeError(e));
    }
    finally {
        busy.current = false;
        setSaving(false);
    } }
    const title = editor.kind === 'manual' ? (editor.sale ? 'Editar venda manual' : 'Lançar venda manual') : editor.kind === 'installment' ? 'Parcela de comissão' : editor.kind === 'rule' ? 'Regra de comissão' : editor.kind === 'cancel' ? 'Cancelar venda manual' : 'Conferir alteração da origem';
    return <Dialog open onOpenChange={open => { if (!open && !busy.current)
        close(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{editor.kind === 'rule' ? 'Mudanças valem apenas para novas vendas. As parcelas existentes preservam sua regra.' : 'Somente Paloma pode alterar estes dados. Toda alteração fica no histórico.'}</DialogDescription></DialogHeader><fieldset disabled={saving} className="space-y-4">
 {editor.kind === 'manual' && <ManualForm sale={editor.sale} today={today} submit={data => save(() => call(editor.sale ? 'sales/' + editor.sale.id : 'sales', editor.sale ? 'PATCH' : 'POST', data))}/>}
 {editor.kind === 'installment' && <InstallmentForm row={editor.row} today={today} submit={data => save(() => call('installments/' + editor.row.id, 'PATCH', data))}/>}
 {editor.kind === 'rule' && <RuleForm rule={editor.rule} submit={data => save(() => call('rule', 'POST', data))}/>}
 {(editor.kind === 'cancel' || editor.kind === 'reconcile') && <><p className="font-semibold">{editor.sale.description}</p>{editor.kind === 'reconcile' && editor.sale.source_current && <div className="rounded-lg bg-muted p-3 text-sm"><p>Financeiro atual: {brl(editor.sale.amount)} · {humanDate(editor.sale.closed_on)}</p><p>Origem atualizada: {brl(editor.sale.source_current.amount)} · {humanDate(editor.sale.source_current.closed_on)}</p></div>}<p className="text-sm text-muted-foreground">{editor.kind === 'cancel' ? 'A venda sairá das projeções; o histórico será preservado. Vendas com parcelas recebidas não podem ser canceladas.' : 'Aplicar o valor e a data atuais da área Parceiros às parcelas desta venda? As datas ajustadas manualmente serão mantidas. Havendo recebimentos, será necessário conferir e desfazer a marcação antes de recalcular.'}</p><Button variant={editor.kind === 'cancel' ? 'destructive' : 'default'} className="w-full" onClick={() => save(() => call('sales/' + editor.sale.id + '/' + editor.kind, 'POST', { expectedVersion: editor.sale.version, ...(editor.kind === 'reconcile' ? { expectedSourceVersion: editor.sale.source_current?.version } : {}) }))}>{editor.kind === 'cancel' ? 'Confirmar cancelamento' : 'Aplicar alteração da origem'}</Button></>}
 </fieldset>{saving && <p role="status" className="text-sm text-muted-foreground">Salvando…</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button variant="ghost" disabled={saving} onClick={close}>Fechar</Button></DialogContent></Dialog>;
}
function ManualForm({ sale, today, submit }: {
    sale?: FinanceSale;
    today: string;
    submit: (data: unknown) => Promise<void>;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const [name, setName] = useState(sale?.description ?? '');
    const [amount, setAmount] = useState(sale ? amountInput(sale.amount) : '');
    const [date, setDate] = useState(sale?.closed_on ?? today);
    const [error, setError] = useState('');
    async function onSubmit(e: FormEvent) { e.preventDefault(); setError(''); try {
        await submit({ description: name.trim(), amount: parsePartnerAmount(amount), closed_on: date, ...(sale ? { expectedVersion: sale.version } : { requestId }) });
    }
    catch (e) {
        setError(financeError(e));
    } }
    return <form onSubmit={onSubmit} className="space-y-4"><Field label="Identificação da venda"><input required maxLength={200} className={financeInput} placeholder="Cliente, contrato ou referência" value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Valor total vendido (R$)"><input required inputMode="decimal" className={financeInput} placeholder="Ex.: 250.000,00" value={amount} onChange={e => setAmount(e.target.value)}/></Field><Field label="Data de fechamento"><input required type="date" min="2000-01-01" max={today} className={financeInput} value={date} onChange={e => setDate(e.target.value)}/></Field><p className="text-xs text-muted-foreground">A comissão será calculada automaticamente. Não cadastre aqui uma venda que já foi lançada na área Parceiros, pois ela é importada automaticamente.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" className="w-full">{sale ? 'Salvar alteração' : 'Gerar parcelas'}</Button></form>;
}
function InstallmentForm({ row, today, submit }: {
    row: FinanceInstallment;
    today: string;
    submit: (data: unknown) => Promise<void>;
}) {
    const [due, setDue] = useState(row.due_on);
    const [received, setReceived] = useState(row.received_on ?? today);
    const [undo, setUndo] = useState(false);
    return <div className="space-y-5"><div className="rounded-lg bg-muted p-3 text-sm"><p className="font-medium">{row.description}</p><p>Parcela {row.number} · {brl(row.amount)}</p><p>{row.received_on ? 'Recebida em ' + humanDate(row.received_on) : 'Ainda não recebida'}</p></div><form onSubmit={e => { e.preventDefault(); void submit({ expectedVersion: row.version, due_on: due }); }} className="space-y-3"><Field label="Vencimento"><input required type="date" min="2000-01-01" max="2100-12-31" value={due} onChange={e => setDue(e.target.value)} className={financeInput}/></Field><Button variant="outline" type="submit" disabled={due === row.due_on} className="w-full">Alterar vencimento</Button></form><div className="border-t pt-4">{row.received_on ? <><label className="flex gap-2 text-sm"><input type="checkbox" checked={undo} onChange={e => setUndo(e.target.checked)}/>Confirmo que desejo desfazer a marcação de recebimento.</label><Button variant="destructive" className="mt-3 w-full" disabled={!undo} onClick={() => submit({ expectedVersion: row.version, received_on: null })}>Desfazer recebimento</Button></> : <form onSubmit={e => { e.preventDefault(); void submit({ expectedVersion: row.version, received_on: received }); }} className="space-y-3"><Field label="Data real de recebimento"><input required type="date" min="2000-01-01" max={today} className={financeInput} value={received} onChange={e => setReceived(e.target.value)}/></Field><Button className="w-full" type="submit">Confirmar recebimento de {brl(row.amount)}</Button></form>}</div></div>;
}
function RuleForm({ rule, submit }: {
    rule: FinanceRule;
    submit: (data: unknown) => Promise<void>;
}) {
    const pct = (bps: number) => (bps / 100).toFixed(2).replace('.', ',');
    const [total, setTotal] = useState(pct(rule.total_bps));
    const [weights, setWeights] = useState(rule.distribution.map(pct));
    const [confirm, setConfirm] = useState(false);
    const [error, setError] = useState('');
    function bps(value: string) { if (!/^\d+(?:[,.]\d{1,2})?$/.test(value.trim()))
        throw new Error('Use percentuais com até duas casas decimais.'); return Math.round(Number(value.replace(',', '.')) * 100); }
    async function save(e: FormEvent) { e.preventDefault(); setError(''); try {
        const distribution = weights.map(bps);
        const total_bps = bps(total);
        if (distribution.reduce((a, b) => a + b, 0) !== total_bps)
            throw new Error('A soma das parcelas deve ser igual ao percentual total.');
        await submit({ expectedVersion: rule.version, total_bps, distribution });
    }
    catch (e) {
        setError(financeError(e));
    } }
    return <form onSubmit={save} className="space-y-4"><p className="text-sm text-muted-foreground">Regra atual v{rule.version}. Padrão: 0,50% em cinco parcelas de 0,20 / 0,10 / 0,10 / 0,05 / 0,05% sobre a venda.</p><div className="grid grid-cols-2 gap-3"><Field label="Comissão total (%)"><input required inputMode="decimal" className={financeInput} value={total} onChange={e => setTotal(e.target.value)}/></Field><Field label="Número de parcelas"><select className={financeInput} value={weights.length} onChange={e => setWeights(old => Array.from({ length: Number(e.target.value) }, (_, i) => old[i] ?? '0,00'))}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></Field></div><div className="grid grid-cols-2 gap-3">{weights.map((v, i) => <Field key={i} label={`${i + 1}ª parcela · mês +${i} (%)`}><input required inputMode="decimal" className={financeInput} value={v} onChange={e => setWeights(old => old.map((w, j) => j === i ? e.target.value : w))}/></Field>)}</div><p className="text-xs text-muted-foreground">Vencimentos automáticos no último dia de cada mês. Ajustes de datas são feitos individualmente em cada parcela.</p><label className="flex gap-2 text-sm"><input required type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/>Confirmo que a nova regra vale somente para novas vendas.</label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={!confirm} className="w-full">Salvar nova versão da regra</Button></form>;
}
