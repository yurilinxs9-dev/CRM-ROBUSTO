'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSocket, joinLead, leaveLead } from '@/lib/socket';
import {
  agruparPorDia,
  CATEGORIAS,
  filtrarPorCategoria,
  type Categoria,
  type TimelinePage,
} from '@/lib/lead-timeline-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NotaInternaComposer } from '@/components/chat/nota-interna-composer';
import { TimelineItemView } from './timeline-item';
import { cn } from '@/lib/cn';

function statusDe(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/** Rajada de mensagem nova vira UMA invalidacao (a timeline recarrega todas
 *  as paginas ja abertas; sem isto cada mensagem do burst refazia tudo). */
const DEBOUNCE_WS_MS = 400;

// Meio-dia evita que o fuso jogue a data para o dia anterior.
const diaLegivel = (dia: string) =>
  new Date(`${dia}T12:00:00`).toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });

export function LeadTimeline({ leadId, editavel }: { leadId: string; editavel: boolean }) {
  const queryClient = useQueryClient();
  const [categoria, setCategoria] = useState<Categoria>('tudo');

  const q = useInfiniteQuery<TimelinePage>({
    queryKey: ['lead-timeline', leadId],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '40' };
      // Cursor e opaco: volta para o backend do jeito que veio.
      if (typeof pageParam === 'string') params.cursor = pageParam;
      return (await api.get<TimelinePage>(`/api/leads/${leadId}/timeline`, { params })).data;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
    // Backend sem o endpoint (404) ou lead fora do alcance (403) nao melhora
    // com retry: mostra o bloco de erro na hora.
    retry: (count, err) => ![403, 404].includes(statusDe(err) ?? 0) && count < 2,
  });

  // Ao vivo: sala do lead (message:new) e eventos do tenant com leadId.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    joinLead(leadId);
    const socket = getSocket();
    const invalidarTimeline = () =>
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
    // Mensagem nova chega em rajada (sync, conversa quente): so a ultima vale.
    const invalidarComDebounce = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        invalidarTimeline();
      }, DEBOUNCE_WS_MS);
    };
    const seForEsteLead = (payload: { leadId?: string; lead_id?: string }) => {
      if ((payload?.leadId ?? payload?.lead_id) !== leadId) return;
      // Etapa/responsavel muda uma vez: invalida direto, sem espera.
      invalidarTimeline();
      // O cabecalho e os campos leem ['lead', id] — mudanca de etapa ou de
      // responsavel precisa aparecer nos dois lugares, nao so na timeline.
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    };
    const soTimeline = (payload: { leadId?: string; lead_id?: string }) => {
      if ((payload?.leadId ?? payload?.lead_id) === leadId) invalidarComDebounce();
    };
    socket.on('message:new', invalidarComDebounce);
    socket.on('lead:updated', seForEsteLead);
    socket.on('lead:stage-changed', seForEsteLead);
    socket.on('lead:new-message', soTimeline);
    return () => {
      socket.off('message:new', invalidarComDebounce);
      socket.off('lead:updated', seForEsteLead);
      socket.off('lead:stage-changed', seForEsteLead);
      socket.off('lead:new-message', soTimeline);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      leaveLead(leadId);
    };
  }, [leadId, queryClient]);

  const itens = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  // Filtro so de tela: nao refaz a busca, so esconde o que ja veio.
  const visiveis = filtrarPorCategoria(itens, categoria);
  const grupos = agruparPorDia(visiveis);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* No celular o composer vai para o rodape e gruda la; a partir de lg
          volta a ser a primeira coisa da coluna. */}
      {editavel && (
        <div className="sticky bottom-0 z-10 order-last shrink-0 bg-background px-4 pb-2 pt-2 lg:static lg:order-first lg:pb-0 lg:pt-3">
          <NotaInternaComposer leadId={leadId} />
        </div>
      )}

      <div className="shrink-0 px-4 pt-3">
        <div className="flex flex-wrap gap-1">
          {CATEGORIAS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategoria(c.key)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                categoria === c.key
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {q.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <div className="rounded-md border border-destructive/40 p-4 text-center text-sm">
            <p className="text-destructive">Não foi possível carregar a atividade.</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void q.refetch()}>
              Tentar de novo
            </Button>
          </div>
        ) : visiveis.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {categoria === 'tudo' ? 'Nenhuma atividade ainda.' : 'Nada nesta categoria.'}
          </p>
        ) : (
          grupos.map((g) => (
            <div key={g.dia} className="mb-2">
              <p className="sticky top-0 z-10 mb-2 bg-background py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {diaLegivel(g.dia)}
              </p>
              <ol>
                {g.items.map((item) => (
                  <TimelineItemView key={item.id} item={item} leadId={leadId} />
                ))}
              </ol>
            </div>
          ))
        )}
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
