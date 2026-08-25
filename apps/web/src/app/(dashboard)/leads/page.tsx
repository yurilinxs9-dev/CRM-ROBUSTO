'use client';

import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toQueryParams } from '@/lib/lead-filters';
import {
  COLUNAS_DEFAULT,
  fromSavedConfig,
  type ViewColumn,
  type ViewSort,
} from '@/lib/lead-view-config';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { LeadFilterPanel } from '@/components/kanban/lead-filter-panel';
import { LeadDetailDrawer } from '@/components/kanban/lead-detail-drawer';
import { useLeadView } from '@/components/leads/use-lead-view';
import { ViewBar } from '@/components/leads/view-bar';
import { LeadTable, type FieldMeta, type LeadRow } from '@/components/leads/lead-table';

const POR_PAGINA = 50;

/**
 * Colunas que não são campo da ficha.
 *
 * `GET /custom-fields/schema` só conhece o que é editável no lead (nativos com
 * `native_key` + customizados). Estágio, responsável e tags são RELAÇÃO, e
 * última interação / não lidas / última mensagem / tarefas pendentes são
 * derivados que o `mapRow` do backend calcula na listagem — nenhum deles tem
 * linha em `CustomFieldDef`, e sem este catálogo apareceriam na tabela com a
 * chave crua no lugar do rótulo.
 */
const PSEUDO_CAMPOS: ReadonlyArray<readonly [string, FieldMeta]> = [
  ['estagio', { nome: 'Estágio', tipo: 'estagio' }],
  ['responsavel', { nome: 'Responsável', tipo: 'responsavel' }],
  ['tags', { nome: 'Tags', tipo: 'tags' }],
  ['ultima_interacao', { nome: 'Última interação', tipo: 'date' }],
  ['created_at', { nome: 'Criado em', tipo: 'date' }],
  ['ultimo_mensagem', { nome: 'Última mensagem', tipo: 'text' }],
  ['mensagens_nao_lidas', { nome: 'Não lidas', tipo: 'number' }],
  ['pending_tasks_count', { nome: 'Tarefas pendentes', tipo: 'number' }],
] as const;

/**
 * A rota `/leads` — a mesma view do kanban, vista como tabela.
 *
 * Filtro, ordenação e paginação são todos DO SERVIDOR. Com pipeline de milhares
 * de leads, filtrar no cliente daria uma tabela que responde só sobre a fatia
 * baixada — e um filtro que erra sem avisar é pior que nenhum. Por isso os
 * parâmetros entram na queryKey: cada recorte é um cache próprio.
 */
export default function LeadsPage(): JSX.Element {
  const view = useLeadView();
  const [pagina, setPagina] = useState(0);
  const [painelAberto, setPainelAberto] = useState(false);
  const [leadAberto, setLeadAberto] = useState<string | null>(null);

  const { config, filters, setConfig } = view;

  const params = useMemo<Record<string, string>>(
    () => ({
      ...toQueryParams(filters),
      ...(config.sort ? { sort: config.sort.campo, dir: config.sort.dir } : {}),
      limit: String(POR_PAGINA),
      offset: String(pagina * POR_PAGINA),
    }),
    [filters, config.sort, pagina],
  );

  /**
   * Trocar de filtro ou de ordenação volta para a primeira página.
   *
   * Sem isto, quem estava na página 7 e apertava um filtro caía numa tela vazia
   * (offset 350 num resultado de 12 linhas) e concluía que o filtro não achou
   * nada. A comparação é sobre o RECORTE, ignorando limit/offset — senão a
   * virada de página se anularia e prenderia o usuário na primeira.
   *
   * Ajuste DURANTE a renderização, e não num efeito: o React descarta esta
   * passada e re-renderiza com o estado novo antes de pintar, então a query sai
   * uma vez só, já no offset 0. Num efeito, `params` já teria sido calculado com
   * a página velha — dispararia um request em `offset=350` com os filtros novos,
   * outro em 0 logo depois, e o rótulo mostraria "351–400" sobre linhas velhas
   * por um frame. Também cobre o que não passa pelos handlers daqui: trocar de
   * view pela ViewBar muda filtros e sort de uma vez.
   */
  const recorte = JSON.stringify({ f: toQueryParams(filters), s: config.sort });
  const [recorteAnterior, setRecorteAnterior] = useState(recorte);
  if (recorte !== recorteAnterior) {
    setRecorteAnterior(recorte);
    setPagina(0);
  }

  const { data: leads = [], isLoading, isFetching } = useQuery<LeadRow[]>({
    // Prefixo `['leads']` de propósito: a ficha (LeadDetailDrawer) invalida por
    // esse prefixo depois de salvar, e uma chave própria tipo 'leads-lista'
    // ficaria de fora — o usuário editaria o nome do lead e veria o antigo na
    // tabela atrás do drawer.
    queryKey: ['leads', 'lista', params],
    queryFn: async () => (await api.get<LeadRow[]>('/api/leads', { params })).data,
    // A tabela some entre páginas sem isto, e o layout pula a cada Próxima.
    placeholderData: keepPreviousData,
  });

  const { schema, isLoading: carregandoCampos } = useFieldSchema();

  const fieldDefs = useMemo(() => {
    const mapa = new Map<string, FieldMeta>();
    for (const f of schema?.fields ?? []) {
      if (f.escopo !== 'LEAD' || !f.active) continue;
      // `native_key` manda: é a coluna real do lead. Nula = chave dentro de
      // `dados_custom` — a mesma tradução que a ficha faz.
      mapa.set(f.native_key ?? f.key, { nome: f.nome, tipo: f.tipo });
    }
    // Os pseudo entram POR ÚLTIMO de propósito: a tabela desenha estágio, tags
    // e responsável por chave, e um campo customizado que por acaso se chamasse
    // `tags` ficaria com rótulo próprio e conteúdo de outro campo.
    for (const [key, meta] of PSEUDO_CAMPOS) mapa.set(key, meta);
    return mapa;
  }, [schema]);

  const aplicarColunas = useCallback(
    (colunas: ViewColumn[]) => {
      // Ocultar a coluna pela qual a tabela está ordenada leva o sort junto.
      // O servidor continuaria ordenando por um campo que sumiu da tela, sem
      // seta em lugar nenhum e sem o ciclo asc→desc→nada para desfazer.
      // A checagem é sobre a SAÍDA (estava antes, não está agora): zerar sempre
      // que o campo não estivesse visível apagaria, num simples arrasto de
      // borda, o sort de uma view salva que já nascia assim.
      const antes = config.colunas.length > 0 ? config.colunas : COLUNAS_DEFAULT;
      const campo = config.sort?.campo;
      const saiu =
        !!campo && antes.some((c) => c.key === campo) && !colunas.some((c) => c.key === campo);

      // `fromSavedConfig` normaliza a ORDEM DAS CHAVES e a faixa das larguras.
      // `configIgual` compara por JSON.stringify: um objeto montado à mão com as
      // chaves em outra ordem daria "sujo" eterno mesmo sem nada ter mudado.
      setConfig(fromSavedConfig({ ...config, colunas, sort: saiu ? null : config.sort }));
    },
    [config, setConfig],
  );

  const aplicarSort = useCallback(
    (sort: ViewSort | null) => setConfig(fromSavedConfig({ ...config, sort })),
    [config, setConfig],
  );

  const temProxima = leads.length === POR_PAGINA;
  const primeiroDaPagina = pagina * POR_PAGINA;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewBar view={view} mode="lista" onOpenFilters={() => setPainelAberto(true)} />

      <LeadFilterPanel
        value={view.filters}
        onChange={view.setFilters}
        open={painelAberto}
        onOpenChange={setPainelAberto}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {/* O schema entra no gate junto com os leads: sem ele `fieldDefs` só
            tem os pseudo, e o cabeçalho piscaria as chaves cruas (`nome`,
            `valor_estimado`) com o menu de colunas vazio. */}
        {isLoading || carregandoCampos ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <LeadTable
            leads={leads}
            colunas={config.colunas}
            fieldDefs={fieldDefs}
            onRowClick={setLeadAberto}
            onColumnsChange={aplicarColunas}
            sort={config.sort}
            onSortChange={aplicarSort}
          />
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {leads.length > 0
              ? `${primeiroDaPagina + 1}–${primeiroDaPagina + leads.length}`
              : 'Sem resultados'}
          </span>

          {isFetching && !isLoading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={pagina === 0 || isFetching}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Anterior
            </Button>
            {/* A API não devolve total; página cheia é o único indício de que
                pode haver mais. Página curta = acabou. */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={!temProxima || isFetching}
              onClick={() => setPagina((p) => p + 1)}
            >
              Próxima
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <LeadDetailDrawer
        leadId={leadAberto}
        open={!!leadAberto}
        onClose={() => setLeadAberto(null)}
      />
    </div>
  );
}
