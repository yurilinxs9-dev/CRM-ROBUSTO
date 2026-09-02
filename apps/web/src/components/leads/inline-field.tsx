'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { decidirCommit, formatarExibicao, type Variante } from '@/lib/inline-field-state';

export interface InlineFieldProps {
  label: string;
  variante: Variante;
  value: string | null;
  /** Rejeita com Error(message) para mostrar o erro abaixo do campo. */
  onSave: (valor: string | null) => Promise<void>;
  opcoes?: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

type Estado = 'leitura' | 'edicao' | 'salvando';

/**
 * Campo editável no lugar: clica, edita, Enter/blur salva, Esc cancela. Valor
 * igual não chama onSave. Erro da API aparece abaixo e o valor volta.
 */
export function InlineField({
  label,
  variante,
  value,
  onSave,
  opcoes = [],
  placeholder = 'Adicionar…',
  disabled = false,
  className,
}: InlineFieldProps) {
  const [estado, setEstado] = useState<Estado>('leitura');
  const [rascunho, setRascunho] = useState(value ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // O select fecha depois de escolher: sem esta marca o onOpenChange leria um
  // `estado` ainda 'edicao' e cancelaria por cima do salvamento em curso.
  const escolheuRef = useRef(false);

  useEffect(() => {
    if (estado === 'leitura') setRascunho(value ?? '');
  }, [value, estado]);

  useEffect(() => {
    if (estado === 'edicao' && variante !== 'select') inputRef.current?.focus();
  }, [estado, variante]);

  const cancelar = () => {
    setRascunho(value ?? '');
    setErro(null);
    setEstado('leitura');
  };

  const salvar = async (bruto: string) => {
    const decisao = decidirCommit(variante, value, bruto);
    if (decisao.acao === 'ignorar') {
      if (decisao.motivo === 'invalido') {
        setErro(variante === 'email' ? 'E-mail inválido' : 'Valor inválido');
        return;
      }
      cancelar();
      return;
    }
    setEstado('salvando');
    setErro(null);
    try {
      await onSave(decisao.valor);
      setEstado('leitura');
    } catch (e) {
      setErro(e instanceof Error && e.message ? e.message : 'Não foi possível salvar');
      setRascunho(value ?? '');
      setEstado('leitura');
    }
  };

  const exibido = formatarExibicao(variante, value, opcoes);

  const abrirEdicao = () => {
    if (disabled) return;
    escolheuRef.current = false;
    setEstado('edicao');
  };

  const renderEdicao = () => {
    if (variante === 'select') {
      return (
        <Select
          defaultOpen
          value={rascunho}
          onValueChange={(v) => {
            escolheuRef.current = true;
            void salvar(v);
          }}
          onOpenChange={(aberto) => {
            if (!aberto && !escolheuRef.current) cancelar();
          }}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {opcoes.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        ref={inputRef}
        className="h-8 text-sm"
        value={rascunho}
        placeholder={placeholder}
        inputMode={variante === 'currency' || variante === 'phone' ? 'decimal' : undefined}
        type={variante === 'email' ? 'email' : 'text'}
        onChange={(e) => setRascunho(e.target.value)}
        onBlur={() => void salvar(rascunho)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void salvar(rascunho);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelar();
          }
        }}
      />
    );
  };

  const renderLeitura = () => (
    <button
      type="button"
      disabled={disabled || estado === 'salvando'}
      onClick={abrirEdicao}
      className={cn(
        'group flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm',
        disabled ? 'cursor-default' : 'hover:bg-accent/50',
      )}
      aria-label={`Editar ${label}`}
    >
      <span className={cn('truncate', exibido === '' && 'text-muted-foreground')}>
        {exibido === '' ? placeholder : exibido}
      </span>
      {estado === 'salvando' && (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      {estado !== 'salvando' && !disabled && (
        <Pencil className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  );

  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {estado === 'edicao' ? renderEdicao() : renderLeitura()}
      {erro && <p className="px-2 text-xs text-destructive">{erro}</p>}
    </div>
  );
}
