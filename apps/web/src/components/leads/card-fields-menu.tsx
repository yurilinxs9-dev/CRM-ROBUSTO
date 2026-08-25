'use client';

/**
 * Popover "Campos do card": edita config.card_fields da view (kanban).
 * Semântica do valor: [] = mostrar tudo (os 5 aparecem marcados). Desmarcar
 * grava lista explícita; voltar a marcar os 5 emite [] de novo (evita view
 * "explícita" idêntica ao default). Mínimo 1 marcado: [] já significa
 * "tudo", não há como representar "nenhum" sem mexer na API.
 * A identidade do card (nome, foto, não lidas, alertas) não é configurável
 * e por isso não aparece aqui.
 */

import { Eye, EyeOff, LayoutList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Os 5 blocos que o LeadCard gateia via mostrar() — mesma vocabulário de lead-card.tsx. */
const CAMPOS_DO_CARD: ReadonlyArray<{ key: string; rotulo: string }> = [
  { key: 'valor_estimado', rotulo: 'Valor estimado' },
  { key: 'tags', rotulo: 'Tags' },
  { key: 'telefone', rotulo: 'Telefone' },
  { key: 'temperatura', rotulo: 'Temperatura' },
  { key: 'proximo_followup', rotulo: 'Próximo follow-up' },
];

interface CardFieldsMenuProps {
  /** config.card_fields da view ([] = tudo visível). */
  value: string[];
  onChange: (fields: string[]) => void;
}

export function CardFieldsMenu({ value, onChange }: CardFieldsMenuProps): JSX.Element {
  const marcados = value.length === 0 ? CAMPOS_DO_CARD.map((c) => c.key) : value;
  const marcado = (key: string) => marcados.includes(key);
  const soUmMarcado = marcados.length === 1;

  const alternar = (key: string) => {
    const novos = marcado(key) ? marcados.filter((k) => k !== key) : [...marcados, key];
    onChange(novos.length === CAMPOS_DO_CARD.length ? [] : novos);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Campos do card">
          <LayoutList className="h-3.5 w-3.5" />
          Campos
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Campos visíveis no card
        </p>
        {CAMPOS_DO_CARD.map((campo) => {
          const ativo = marcado(campo.key);
          const travado = ativo && soUmMarcado;
          return (
            <button
              key={campo.key}
              type="button"
              disabled={travado}
              onClick={() => alternar(campo.key)}
              title={travado ? 'Pelo menos um campo precisa ficar visível' : undefined}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              style={{ color: ativo ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              {ativo ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {campo.rotulo}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
