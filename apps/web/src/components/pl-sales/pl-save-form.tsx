'use client';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { plError } from '@/lib/pl-sales';
import { Button } from '@/components/ui/button';

export interface PlFormActions { saved: () => Promise<void>; refresh: () => Promise<void>; onBusy: (busy: boolean) => void }

export function PlSaveForm({ children, save, refresh, onBusy, label, versioned = true, destructive = false, disabled = false }: {
  children: ReactNode; save: () => Promise<void>; label: string; versioned?: boolean; destructive?: boolean; disabled?: boolean;
} & Pick<PlFormActions, 'refresh' | 'onBusy'>) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || conflict || disabled) return;
    lock.current = true; setBusy(true); onBusy(true); setError('');
    try { await save(); }
    catch (error) {
      const changed = isAxiosError(error) && error.response?.status === 409;
      setConflict(changed && versioned);
      setError(changed
        ? `${plError(error)} ${versioned ? 'Atualize os dados e reabra o registro para revisar antes de salvar.' : 'Confira o número: um contrato já registrado, mesmo cancelado, não pode ser lançado novamente.'}`
        : plError(error));
    } finally { lock.current = false; setBusy(false); onBusy(false); }
  }

  return <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
    <fieldset disabled={busy || conflict || disabled} className="min-w-0 space-y-4">{children}</fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {conflict && <Button type="button" variant="outline" className="w-full" onClick={() => void refresh()}>Atualizar e revisar</Button>}
    <Button type="submit" variant={destructive ? 'destructive' : 'default'} className="w-full" disabled={busy || conflict || disabled}>{busy ? 'Salvando…' : label}</Button>
  </form>;
}
