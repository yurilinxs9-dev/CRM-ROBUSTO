'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { COLUNAS_DEFAULT, type ViewColumn, type ViewSort } from '@/lib/lead-view-config';
import { ColumnMenu } from './column-menu';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * A linha como `GET /api/leads` devolve — só o que a tabela lê.
 *
 * `type` e não `interface` de propósito: apenas alias de objeto ganha index
 * signature implícita, e sem ela o TypeScript recusa `const rec:
 * Record<string, unknown> = lead`, que é como uma coluna de chave dinâmica
 * (nativa ou custom) acha o valor sem `any`.
 */
export type LeadRow = {
  id: string;
  nome: string;
  telefone: string;
  email?: string | null;
  empresa?: string | null;
  cargo?: string | null;
  temperatura?: string | null;
  /** Decimal do Prisma chega serializado como string. */
  valor_estimado?: string | number | null;
  tags?: string[] | null;
  lead_tags?: { tag: { id: string; nome: string; cor: string } }[] | null;
  estagio?: { id: string; nome: string; cor: string } | null;
  responsavel?: { id: string; nome: string; avatar_url?: string | null } | null;
  created_at?: string | null;
  ultima_interacao?: string | null;
  proximo_followup?: string | null;
  mensagens_nao_lidas?: number | null;
  ultimo_mensagem?: string | null;
  pending_tasks_count?: number | null;
  dados_custom?: Record<string, unknown> | null;
};

export interface FieldMeta {
  nome: string;
  tipo: string;
}

interface LeadTableProps {
  leads: LeadRow[];
  /** Vazio cai em `COLUNAS_DEFAULT` — view nova abre mostrando alguma coisa. */
  colunas: ViewColumn[];
  fieldDefs: Map<string, FieldMeta>;
  onRowClick: (id: string) => void;
  /** Resize, reordenação e inclusão/exclusão de coluna saem todos por aqui. */
  onColumnsChange: (c: ViewColumn[]) => void;
  sort: ViewSort | null;
  onSortChange: (s: ViewSort | null) => void;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Espelha a whitelist de `lead-sort.ts` no backend: fora dela o clique no
 *  cabeçalho não faria nada — a API cairia na ordenação padrão em silêncio, e
 *  a seta na tela estaria mentindo. Sem seta, nada a explicar. */
const ORDENAVEIS: ReadonlySet<string> = new Set([
  'nome',
  'created_at',
  'temperatura',
  'ultima_interacao',
  'valor_estimado',
  'proximo_followup',
]);

export const LARGURA_PADRAO = 160;
export const LARGURA_MIN = 60;
export const LARGURA_MAX = 640;
/** Faixa do botão "Colunas" no canto do cabeçalho. */
const LARGURA_MENU = 44;

/** Mesmos limites de `fromSavedConfig`, para o que é arrastado ser o que é
 *  gravado — largura fora da faixa voltaria do banco diferente e a barra
 *  acenderia "não salvo" logo depois de salvar. */
export const clampLargura = (w: number): number =>
  Math.min(LARGURA_MAX, Math.max(LARGURA_MIN, Math.round(w)));

const TEMP_CORES: Record<string, { bg: string; fg: string; label: string }> = {
  FRIO: { bg: 'rgba(148,163,184,0.18)', fg: '#94a3b8', label: 'Frio' },
  MORNO: { bg: 'rgba(250,204,21,0.18)', fg: '#eab308', label: 'Morno' },
  QUENTE: { bg: 'rgba(249,115,22,0.18)', fg: '#f97316', label: 'Quente' },
  MUITO_QUENTE: { bg: 'rgba(239,68,68,0.18)', fg: '#ef4444', label: 'Muito quente' },
};

const moedaFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------------------
// Formatação de valor
// ---------------------------------------------------------------------------

/** `2026-08-25` — data pura, sem hora nem fuso. */
const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Data -> `dd/mm/aaaa`, respeitando a diferença entre data pura e instante.
 *
 * Campo customizado do tipo `date` é gravado CRU, no formato do
 * `<input type="date">` (ver `coerceValue` em field-schema.ts): `2026-08-25`.
 * `new Date('2026-08-25')` é meia-noite UTC pelo spec, e em UTC-3 isso vira
 * 24/08 na tela — todo aniversário e toda data de fechamento apareceria um dia
 * antes. Data pura é montada em horário LOCAL; datetime completo (created_at,
 * ultima_interacao) é instante de verdade e continua convertido para o fuso do
 * usuário, que é o certo ali.
 */
function textoData(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  if (typeof v === 'string') {
    const m = SO_DATA.exec(v);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
    }
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
}

/**
 * Valor cru -> texto, guiado pelo `tipo` do campo.
 *
 * Nada aqui pode estourar: `dados_custom` é Json livre, gravado por importação
 * e por API de cliente, então o mesmo `key` pode vir número numa linha e objeto
 * na seguinte. Célula errada é ruim; tabela que não renderiza é pior.
 */
export function formatarValor(v: unknown, tipo: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'boolean' || typeof v === 'boolean') {
    return v === true || v === 'true' || v === 1 ? 'Sim' : 'Não';
  }
  if (tipo === 'currency') {
    const n = typeof v === 'number' ? v : Number(String(v));
    return Number.isFinite(n) ? moedaFmt.format(n) : String(v);
  }
  if (tipo === 'date') return textoData(v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v);
}

/** Nativo primeiro, `dados_custom` depois — a mesma regra de `native_key` da
 *  ficha: chave que é coluna real do lead nunca é procurada no Json. */
function valorBruto(lead: LeadRow, key: string): unknown {
  const rec: Record<string, unknown> = lead;
  // `hasOwnProperty` e não `key in rec`: `in` anda pela cadeia de protótipos, e
  // um campo customizado com chave `constructor` ou `toString` acharia o membro
  // de Object.prototype em vez do valor do lead — a célula imprimiria o código
  // da função. As chaves vêm do tenant, então isso é entrada de usuário.
  if (Object.prototype.hasOwnProperty.call(rec, key)) return rec[key];
  const custom = lead.dados_custom;
  if (!custom || !Object.prototype.hasOwnProperty.call(custom, key)) return undefined;
  return custom[key];
}

// ---------------------------------------------------------------------------
// Célula
// ---------------------------------------------------------------------------

/** Texto de uma linha só, cortado com reticências e com o valor inteiro no
 *  `title` — a coluna é estreita por definição, e sem o tooltip o usuário teria
 *  que abrir a ficha só para ler o que não coube. */
function Texto({ children }: { children: string }): JSX.Element {
  return (
    <span className="block truncate" title={children || undefined}>
      {children}
    </span>
  );
}

function conteudoCelula(lead: LeadRow, key: string, tipo: string): JSX.Element {
  // As chaves abaixo não são campo escalar: são relação ou enum com semântica
  // própria, e por isso vêm ANTES do despacho por tipo.
  if (key === 'estagio') {
    if (!lead.estagio) return <Texto>{''}</Texto>;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: lead.estagio.cor || 'var(--text-muted)' }}
        />
        <span className="truncate">{lead.estagio.nome}</span>
      </span>
    );
  }

  if (key === 'responsavel') return <Texto>{lead.responsavel?.nome ?? ''}</Texto>;

  if (key === 'tags') {
    const doBanco = (lead.lead_tags ?? []).map((lt) => lt.tag);
    // `lead.tags` é a lista legada de strings; ainda é o que algumas telas
    // gravam, então serve de fallback quando a relação não veio no select.
    const chips = doBanco.length
      ? doBanco
      : (lead.tags ?? []).map((nome) => ({ id: nome, nome, cor: '' }));
    if (chips.length === 0) return <Texto>{''}</Texto>;
    return (
      <span className="flex flex-wrap items-center gap-1">
        {chips.map((t) => (
          <span
            key={t.id}
            className="max-w-[120px] truncate rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: t.cor ? `${t.cor}26` : 'var(--bg-surface-2)',
              color: t.cor || 'var(--text-secondary)',
            }}
          >
            {t.nome}
          </span>
        ))}
      </span>
    );
  }

  if (key === 'temperatura') {
    const temp = typeof lead.temperatura === 'string' ? lead.temperatura : '';
    const cor = TEMP_CORES[temp];
    if (!cor) return <Texto>{temp}</Texto>;
    return (
      <span
        className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold"
        style={{ background: cor.bg, color: cor.fg }}
      >
        {cor.label}
      </span>
    );
  }

  return <Texto>{formatarValor(valorBruto(lead, key), tipo)}</Texto>;
}

// ---------------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------------

/**
 * A tabela do modo Lista.
 *
 * Colunas, larguras e ordenação são estado da VIEW, não da tabela: tudo o que o
 * usuário mexe aqui sai por `onColumnsChange`/`onSortChange` e volta como prop.
 * É o que faz a barra de cima acender "alterações não salvas" ao arrastar uma
 * borda — a tabela não guarda preferência nenhuma por conta própria.
 *
 * A única exceção é a largura DURANTE o arrasto, que é efêmera de propósito:
 * emitir a cada pixel encheria o histórico e faria a view parecer suja por um
 * arrasto que o usuário ainda ia cancelar. O commit é no mouseup.
 */
export function LeadTable({
  leads,
  colunas,
  fieldDefs,
  onRowClick,
  onColumnsChange,
  sort,
  onSortChange,
}: LeadTableProps): JSX.Element {
  const efetivas = colunas.length > 0 ? colunas : COLUNAS_DEFAULT;

  const arrasto = useRef<{ key: string; startX: number; startW: number; w: number } | null>(null);
  const [viva, setViva] = useState<{ key: string; w: number } | null>(null);

  const commitLargura = useCallback(
    (key: string, w: number) => {
      onColumnsChange(efetivas.map((c) => (c.key === key ? { key: c.key, width: w } : c)));
    },
    [efetivas, onColumnsChange],
  );

  // Os listeners ficam no window, e não na alça: o ponteiro sai do <th> logo no
  // primeiro pixel de arrasto rápido, e um mouseup fora da alça deixaria a
  // coluna presa ao cursor. Ficam sempre montados (o guard é o ref) para o
  // efeito não reassinar a cada movimento do mouse.
  useEffect(() => {
    const mover = (e: MouseEvent) => {
      const a = arrasto.current;
      if (!a) return;
      a.w = clampLargura(a.startW + (e.clientX - a.startX));
      setViva({ key: a.key, w: a.w });
    };
    const soltar = () => {
      const a = arrasto.current;
      if (!a) return;
      arrasto.current = null;
      setViva(null);
      // Clique sem arrasto não é edição: gravar a largura mesmo assim fixaria o
      // padrão de 160 na view e acenderia "alterações não salvas" por nada.
      if (a.w !== a.startW) commitLargura(a.key, a.w);
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
    return () => {
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
    };
  }, [commitLargura]);

  const larguraDe = useCallback(
    (c: ViewColumn): number =>
      viva && viva.key === c.key ? viva.w : clampLargura(c.width ?? LARGURA_PADRAO),
    [viva],
  );

  const larguraTotal = useMemo(
    () => efetivas.reduce((soma, c) => soma + larguraDe(c), 0) + LARGURA_MENU,
    [efetivas, larguraDe],
  );

  const iniciarResize = (e: React.MouseEvent, c: ViewColumn) => {
    // Só o botão esquerdo arrasta. O direito abriria o menu de contexto E
    // armaria o arrasto, e o mouseup correspondente gravaria a largura.
    if (e.button !== 0) return;
    // Sem isto o mousedown na alça também dispara a ordenação do cabeçalho e
    // seleciona texto da página inteira enquanto arrasta.
    e.preventDefault();
    e.stopPropagation();
    const w = larguraDe(c);
    arrasto.current = { key: c.key, startX: e.clientX, startW: w, w };
    setViva({ key: c.key, w });
  };

  /** asc -> desc -> sem ordenação. O terceiro clique precisa existir: sem ele
   *  não há como voltar à ordem padrão da tela sem recarregar. */
  const alternarSort = (key: string) => {
    if (!ORDENAVEIS.has(key)) return;
    if (!sort || sort.campo !== key) onSortChange({ campo: key, dir: 'asc' });
    else if (sort.dir === 'asc') onSortChange({ campo: key, dir: 'desc' });
    else onSortChange(null);
  };

  const rotulo = (key: string): string => fieldDefs.get(key)?.nome ?? key;
  const tipoDe = (key: string): string => fieldDefs.get(key)?.tipo ?? 'text';

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border-default)' }}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed text-sm" style={{ minWidth: larguraTotal }}>
          {/* A última <col> não tem largura de propósito. Em `table-fixed` a
              sobra de espaço é redistribuída PROPORCIONALMENTE entre as colunas
              dimensionadas; numa tela larga, uma coluna arrastada para 200px
              apareceria com 260. Com uma coluna automática no fim, toda a sobra
              vai para ela e as larguras salvas valem exatamente o que dizem. */}
          <colgroup>
            {efetivas.map((c) => (
              <col key={c.key} style={{ width: larguraDe(c) }} />
            ))}
            <col style={{ width: LARGURA_MENU }} />
            <col />
          </colgroup>

          {/* O sticky vai nas CÉLULAS, não no <thead>: sticky em thead/tr é
              suporte recente e irregular entre navegadores, e o fundo de um
              <tr> não pinta atrás de um <th> grudado — o cabeçalho ficaria
              transparente com as linhas passando por baixo. */}
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
              {efetivas.map((c) => {
                const ordenavel = ORDENAVEIS.has(c.key);
                const ativo = sort?.campo === c.key;
                const Seta = !ativo ? ChevronsUpDown : sort?.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className="sticky top-0 z-10 select-none px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'var(--bg-surface-2)',
                      boxShadow: 'inset 0 -1px 0 var(--border-default)',
                    }}
                    aria-sort={ativo ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => alternarSort(c.key)}
                      disabled={!ordenavel}
                      title={ordenavel ? `Ordenar por ${rotulo(c.key)}` : rotulo(c.key)}
                      className={cn(
                        'flex w-full min-w-0 items-center gap-1 text-left uppercase',
                        ordenavel ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
                      )}
                    >
                      <span className="truncate">{rotulo(c.key)}</span>
                      {ordenavel && (
                        <Seta
                          className="h-3 w-3 shrink-0"
                          style={{ opacity: ativo ? 1 : 0.35 }}
                          aria-hidden
                        />
                      )}
                    </button>

                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Redimensionar ${rotulo(c.key)}`}
                      onMouseDown={(e) => iniciarResize(e, c)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                      style={{ background: viva?.key === c.key ? 'var(--primary)' : undefined }}
                    />
                  </th>
                );
              })}

              <th
                scope="col"
                className="sticky top-0 z-10 px-1 py-2 text-right"
                style={{
                  background: 'var(--bg-surface-2)',
                  boxShadow: 'inset 0 -1px 0 var(--border-default)',
                }}
              >
                <ColumnMenu
                  colunas={efetivas}
                  fieldDefs={fieldDefs}
                  onColumnsChange={onColumnsChange}
                />
              </th>

              <th
                scope="col"
                className="sticky top-0 z-10"
                style={{
                  background: 'var(--bg-surface-2)',
                  boxShadow: 'inset 0 -1px 0 var(--border-default)',
                }}
              >
                <span className="sr-only">Espaço restante</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => onRowClick(lead.id)}
                className="cursor-pointer transition-colors hover:bg-accent/40"
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                {efetivas.map((c) => (
                  // `overflow-hidden` no <td>, e o `truncate` DENTRO de cada
                  // conteúdo: `truncate` aqui traria `white-space: nowrap`, que
                  // anularia o flex-wrap dos chips de tag — várias tags seriam
                  // cortadas em vez de quebrar linha.
                  <td
                    key={c.key}
                    className="overflow-hidden px-3 py-2.5"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {conteudoCelula(lead, c.key, tipoDe(c.key))}
                  </td>
                ))}
                {/* Pares das duas <col> extras: menu e sobra. */}
                <td />
                <td />
              </tr>
            ))}

            {leads.length === 0 && (
              <tr>
                <td
                  colSpan={efetivas.length + 2}
                  className="px-3 py-12 text-center"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Nenhum lead com estes filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
