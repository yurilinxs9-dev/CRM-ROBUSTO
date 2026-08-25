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

export function BillingBadge({ billing }: { billing: BillingInfo }) {
  const b = BADGE[billing.status];
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap" style={{ background: b.bg, color: b.fg }}>
      {b.label(billing.dias)}
    </span>
  );
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
