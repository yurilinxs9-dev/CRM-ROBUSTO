'use client';

import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, EyeOff, GripVertical, Settings2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ViewColumn } from '@/lib/lead-view-config';
import type { FieldMeta } from './lead-table';

interface ColumnMenuProps {
  /** As colunas EFETIVAS (já com o default aplicado), na ordem da tela. */
  colunas: ViewColumn[];
  fieldDefs: Map<string, FieldMeta>;
  onColumnsChange: (c: ViewColumn[]) => void;
}

/** Busca sem acento: quem procura "estagio" tem que achar "Estágio". */
const normalizar = (s: string): string =>
  s.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '');

function LinhaVisivel({
  coluna,
  rotulo,
  podeRemover,
  onRemover,
}: {
  coluna: ViewColumn;
  rotulo: string;
  podeRemover: boolean;
  onRemover: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: coluna.key,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-accent/50"
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground"
        aria-label={`Mover ${rotulo}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-primary)' }}>
        {rotulo}
      </span>

      <button
        type="button"
        onClick={onRemover}
        disabled={!podeRemover}
        title={podeRemover ? `Ocultar ${rotulo}` : 'A tabela precisa de ao menos uma coluna'}
        aria-label={`Ocultar ${rotulo}`}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
      >
        <Eye className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * O seletor de colunas, no canto direito do cabeçalho da tabela.
 *
 * Fica aqui e não na ViewBar de propósito: é ajuste DA TABELA, e a barra é
 * compartilhada com o kanban, onde "colunas" quer dizer outra coisa (estágio).
 * Colocar o botão sobre a própria grade que ele altera mantém a ação junto do
 * efeito.
 *
 * Duas listas — visíveis e disponíveis — em vez de uma lista de checkboxes:
 * ordem só existe entre as visíveis, e misturar as duas faria o usuário
 * arrastar um item que não está na tabela para uma posição que não existe.
 */
export function ColumnMenu({ colunas, fieldDefs, onColumnsChange }: ColumnMenuProps): JSX.Element {
  const [busca, setBusca] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rotulo = (key: string): string => fieldDefs.get(key)?.nome ?? key;

  const termo = normalizar(busca.trim());
  const casa = (key: string): boolean =>
    !termo || normalizar(rotulo(key)).includes(termo) || normalizar(key).includes(termo);

  // Sem memo: as duas listas têm dezenas de itens e só existem com o popover
  // aberto — memoizar aqui custaria mais em dependências erradas do que economiza.
  const visiveisFiltradas = colunas.filter((c) => casa(c.key));

  const jaNaTabela = new Set(colunas.map((c) => c.key));
  const disponiveis = Array.from(fieldDefs.keys())
    .filter((k) => !jaNaTabela.has(k) && casa(k))
    .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR'));

  const aoSoltar = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Os índices saem da lista COMPLETA, não da filtrada: com busca ativa a
    // tela mostra um subconjunto, e mover pelo índice do que está visível
    // jogaria a coluna para um lugar que o usuário não apontou.
    const de = colunas.findIndex((c) => c.key === active.id);
    const para = colunas.findIndex((c) => c.key === over.id);
    if (de < 0 || para < 0) return;
    onColumnsChange(arrayMove(colunas, de, para));
  };

  const remover = (key: string) => {
    if (colunas.length <= 1) return;
    onColumnsChange(colunas.filter((c) => c.key !== key));
  };

  const adicionar = (key: string) => onColumnsChange([...colunas, { key }]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Colunas">
          <Settings2 className="h-3.5 w-3.5" />
          <span className="sr-only">Configurar colunas</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b p-2" style={{ borderColor: 'var(--border-default)' }}>
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar campo..."
            autoComplete="off"
            className="h-8 text-xs"
          />
        </div>

        <div className="scrollbar-thin max-h-[320px] overflow-y-auto p-2">
          <p
            className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            Na tabela
          </p>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={aoSoltar}>
            <SortableContext
              items={visiveisFiltradas.map((c) => c.key)}
              strategy={verticalListSortingStrategy}
            >
              {visiveisFiltradas.map((c) => (
                <LinhaVisivel
                  key={c.key}
                  coluna={c}
                  rotulo={rotulo(c.key)}
                  podeRemover={colunas.length > 1}
                  onRemover={() => remover(c.key)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {visiveisFiltradas.length === 0 && (
            <p className="px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Nenhuma coluna com esse nome.
            </p>
          )}

          {disponiveis.length > 0 && (
            <>
              <p
                className="px-1 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Disponíveis
              </p>
              {disponiveis.map((key) => (
                <div
                  key={key}
                  className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-accent/50"
                >
                  {/* Espaçador do lugar da alça: sem ele os rótulos das duas
                      listas não alinham e a coluna vira uma escada. */}
                  <span className="w-3.5 shrink-0" aria-hidden />
                  <span
                    className="min-w-0 flex-1 truncate text-xs"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {rotulo(key)}
                  </span>
                  <button
                    type="button"
                    onClick={() => adicionar(key)}
                    title={`Mostrar ${rotulo(key)}`}
                    aria-label={`Mostrar ${rotulo(key)}`}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
