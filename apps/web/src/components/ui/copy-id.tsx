'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

interface CopyIdProps {
  /** Valor completo a copiar (UUID do tenant/colaborador). */
  value: string;
  /** Rótulo opcional antes do ID (ex: "ID"). */
  label?: string;
  /** Mostra o UUID inteiro em vez de truncado. */
  full?: boolean;
  className?: string;
}

/**
 * Exibe um identificador (UUID) em fonte mono com botão de copiar.
 * Usado no painel de plataforma para o super admin pegar o ID de cada
 * tenant/colaborador — chave estável para integração com o projeto de IA.
 */
export function CopyId({ value, label, full = false, className = '' }: CopyIdProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('ID copiado');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Falha ao copiar');
    }
  };

  const shown = full ? value : `${value.slice(0, 8)}…`;

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copiar ID: ${value}`}
      className={`inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      {label && <span className="not-italic">{label}</span>}
      <span>{shown}</span>
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
