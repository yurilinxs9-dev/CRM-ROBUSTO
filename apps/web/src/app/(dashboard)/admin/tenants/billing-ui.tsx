'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export interface BillingInfo { status: 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido'; dias: number }

export const moneyFmt = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const BADGE: Record<BillingInfo['status'], { bg: string; fg: string; label: (d: number) => string }> = {
  em_dia: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e', label: () => 'Em dia' },
  vence_em_breve: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: (d) => (d === 0 ? 'Vence hoje' : `Vence em ${d}d`) },
  vencido: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', label: (d) => `Vencido há ${d}d` },
  sem_cobranca: { bg: 'rgba(107,114,128,0.15)', fg: '#9ca3af', label: () => 'Sem cobrança' },
};

export function BillingBadge({ billing, title }: { billing: BillingInfo; title?: string }) {
  const b = BADGE[billing.status];
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ background: b.bg, color: b.fg }}
    >
      {b.label(billing.dias)}
    </span>
  );
}

/** "1 dia" / "2 dias" — plural correto. */
export const diasLabel = (n: number) => `${n} ${n === 1 ? 'dia' : 'dias'}`;

/** dd/mm/aaaa (ou dd/mm com short). Datas de cobrança são salvas ao meio-dia UTC. */
export const billingDateFmt = (iso: string, short = false) =>
  new Date(iso).toLocaleDateString('pt-BR', short
    ? { day: '2-digit', month: '2-digit', timeZone: 'UTC' }
    : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

export const BILLING_COLOR: Record<BillingInfo['status'], string> = {
  em_dia: '#22c55e',
  vence_em_breve: '#f59e0b',
  vencido: '#ef4444',
  sem_cobranca: 'var(--text-muted)',
};

/** Status por extenso: diz QUANDO vence e QUANTO falta, sem o admin precisar contar. */
export function billingPhrase(billing: BillingInfo, paidUntil: string | null | undefined): string {
  if (billing.status === 'sem_cobranca' || !paidUntil) return 'Sem cobrança configurada';
  const data = billingDateFmt(paidUntil);
  switch (billing.status) {
    case 'em_dia':
      return `✓ Em dia — vence em ${data} · faltam ${diasLabel(billing.dias)}`;
    case 'vence_em_breve':
      return billing.dias === 0
        ? `Vence em ${data} · é hoje`
        : `Vence em ${data} · faltam ${diasLabel(billing.dias)}`;
    case 'vencido':
      return `Venceu em ${data} · há ${diasLabel(billing.dias)}`;
  }
}

export function DeleteTenantDialog({
  open, onOpenChange, nome, counts, pending, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  nome: string;
  counts: { users: number; leads: number; instances: number };
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Excluir “{nome}”?</DialogTitle>
          <DialogDescription>
            Exclusão total e irreversível: {counts.users} usuário(s), {counts.leads} lead(s) e {counts.instances} instância(s) serão apagados.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Excluir definitivamente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
