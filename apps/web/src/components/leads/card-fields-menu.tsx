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

const CHAVES: ReadonlyArray<string> = CAMPOS_DO_CARD.map((c) => c.key);

export function CardFieldsMenu({ value, onChange }: CardFieldsMenuProps): JSX.Element {
  /**
   * `marcados` sai SEMPRE do vocabulário conhecido, nunca do `value` cru: o
   * array vem do banco gravado por qualquer versão do cliente e pode trazer
   * chave órfã (campo que já existiu) ou repetida. Contar o bruto quebraria os
   * dois invariantes — órfã inflaria o total e o "mínimo 1" deixaria de travar
   * o último campo; duplicata sumiria no filter e emitiria `[]`, que significa
   * o oposto ("mostrar tudo"). Derivar de CHAVES também normaliza ordem e
   * remove repetição, o que estabiliza o JSON.stringify do configIgual.
   *
   * Borda: `value` só com órfãs vira `marcados = []` — nada marcado e nada
   * travado. É a leitura honesta do que está salvo (o LeadCard, com lista não
   * vazia sem nenhum campo conhecido, também não mostra bloco nenhum), e o
   * primeiro clique já emite uma lista válida e devolve a tela ao normal.
   */
  const marcados = value.length === 0 ? CHAVES : CHAVES.filter((k) => value.includes(k));
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
