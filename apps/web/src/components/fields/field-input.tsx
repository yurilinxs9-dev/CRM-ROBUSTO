'use client';

import { Check, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import type { FieldDef } from '@/lib/field-render';

interface FieldInputProps {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}

/** Só para o `<Select>` do Radix, que não aceita SelectItem com value="". */
const VAZIO = '__vazio__';

function MultiSelect({ def, value, onChange, disabled }: FieldInputProps) {
  const selecionados = Array.isArray(value) ? (value as string[]) : [];
  const opcoes = def.options ?? [];

  const alternar = (opt: string) => {
    onChange(
      selecionados.includes(opt)
        ? selecionados.filter((v) => v !== opt)
        : [...selecionados, opt],
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          role="combobox"
          className="w-full justify-between font-normal"
          disabled={disabled}
        >
          <span className={cn('truncate', selecionados.length === 0 && 'text-muted-foreground')}>
            {selecionados.length === 0 ? 'Selecionar…' : selecionados.join(', ')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-1" align="start">
        {opcoes.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma opção configurada</p>
        ) : (
          opcoes.map((opt) => {
            const marcado = selecionados.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => alternar(opt)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded border',
                    marcado ? 'bg-primary border-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {marcado && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate">{opt}</span>
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Renderiza um campo conforme o tipo declarado na definição. */
export function FieldInput({ def, value, onChange, disabled }: FieldInputProps) {
  const id = `campo-${def.escopo}-${def.key}`;
  const texto = value === null || value === undefined ? '' : String(value);

  switch (def.tipo) {
    case 'textarea':
      return (
        <Textarea
          id={id}
          rows={3}
          value={texto}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'select':
      return (
        <Select
          value={texto || VAZIO}
          disabled={disabled}
          onValueChange={(v) => onChange(v === VAZIO ? '' : v)}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Selecionar…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={VAZIO}>
              <span className="text-muted-foreground">Nenhum</span>
            </SelectItem>
            {(def.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'multiselect':
      return <MultiSelect def={def} value={value} onChange={onChange} disabled={disabled} />;

    case 'boolean':
      return (
        <Select
          value={value === true ? 'sim' : value === false ? 'nao' : VAZIO}
          disabled={disabled}
          onValueChange={(v) => onChange(v === VAZIO ? undefined : v === 'sim')}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Selecionar…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={VAZIO}>
              <span className="text-muted-foreground">Não informado</span>
            </SelectItem>
            <SelectItem value="sim">Sim</SelectItem>
            <SelectItem value="nao">Não</SelectItem>
          </SelectContent>
        </Select>
      );

    case 'currency':
      return (
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            R$
          </span>
          <Input
            id={id}
            className="pl-8"
            inputMode="decimal"
            placeholder="0,00"
            value={texto}
            disabled={disabled}
            // Deixa o usuário digitar no formato brasileiro; a conversão para o
            // formato do backend acontece em buildPayload, não aqui.
            onChange={(e) => onChange(e.target.value.replace(/[^0-9.,-]/g, ''))}
          />
        </div>
      );

    default: {
      const htmlType =
        def.tipo === 'date'
          ? 'date'
          : def.tipo === 'number'
            ? 'number'
            : def.tipo === 'email'
              ? 'email'
              : def.tipo === 'url'
                ? 'url'
                : def.tipo === 'phone'
                  ? 'tel'
                  : 'text';
      return (
        <Input
          id={id}
          type={htmlType}
          value={texto}
          disabled={disabled}
          placeholder={def.tipo === 'url' ? 'https://…' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }
}

/** Rótulo + input, com o badge "Apenas API" quando o campo é somente leitura. */
export function FieldRow({ def, value, onChange, disabled }: FieldInputProps) {
  const somenteLeitura = def.api_only || disabled;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`campo-${def.escopo}-${def.key}`} className="truncate">
          {def.nome}
        </Label>
        {def.api_only && (
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            Apenas API
          </Badge>
        )}
      </div>
      <FieldInput def={def} value={value} onChange={onChange} disabled={somenteLeitura} />
    </div>
  );
}
