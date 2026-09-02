'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FileText, ImageOff, Mic, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { rotuloMidia } from '@/lib/lead-timeline-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Galeria de midia do lead. Espelha `MediaItem` de
 * `apps/api/src/modules/leads/lead-timeline.service.ts`; mudou la, muda aqui.
 * `media_url` e `media_thumbnail_url` chegam ja assinadas pelo backend.
 */
interface MediaItem {
  id: string;
  type: string;
  media_url: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  // Midia arquivada pelo cleanup de 30 dias perde `media_url` e sobra so isto.
  media_thumbnail_url: string | null;
  media_duration_seconds: number | null;
  direction: 'INCOMING' | 'OUTGOING';
  created_at: string;
}
interface MediaPage {
  items: MediaItem[];
  nextCursor?: string;
}

function statusDe(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

const data = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

const duracao = (segundos: number) => {
  if (segundos < 60) return `${segundos}s`;
  const min = Math.floor(segundos / 60);
  const seg = String(segundos % 60).padStart(2, '0');
  return `${min}:${seg}`;
};

export function LeadMediaGrid({ leadId }: { leadId: string }) {
  const q = useInfiniteQuery<MediaPage>({
    queryKey: ['lead-media', leadId],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { limit: '40' };
      // Cursor e opaco: volta para o backend do jeito que veio.
      if (typeof pageParam === 'string') params.cursor = pageParam;
      return (await api.get<MediaPage>(`/api/leads/${leadId}/media`, { params })).data;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
    // Backend sem o endpoint (404) ou lead fora do alcance (403) nao melhora
    // com retry: mostra o bloco de erro na hora.
    retry: (count, err) => ![403, 404].includes(statusDe(err) ?? 0) && count < 2,
  });

  const itens = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const visuais = itens.filter((i) => i.type === 'IMAGE' || i.type === 'VIDEO');
  const arquivos = itens.filter((i) => i.type === 'AUDIO' || i.type === 'DOCUMENT');

  if (q.isLoading) {
    return (
      <div className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square" />
        ))}
      </div>
    );
  }

  // Erro de tela cheia so quando nao ha nada carregado: se a primeira pagina ja
  // veio, o erro (tipico de `fetchNextPage`) aparece inline la embaixo.
  if (q.isError && itens.length === 0) {
    return (
      <div className="m-4 rounded-md border border-destructive/40 p-4 text-center text-sm">
        <p className="text-destructive">Não foi possível carregar as mídias.</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void q.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (itens.length === 0) {
    return (
      <p className="p-6 text-center text-xs text-muted-foreground">Nenhuma mídia nesta conversa.</p>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {visuais.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {visuais.map((m) => {
            // A miniatura prefere a thumbnail. Video sem thumbnail NAO cai no
            // proprio arquivo: o mp4 dentro de um <img> quebra a caixa, entao
            // so IMAGE usa `media_url` como miniatura; VIDEO vai ao placeholder.
            const src =
              m.type === 'IMAGE' ? (m.media_thumbnail_url ?? m.media_url) : m.media_thumbnail_url;
            const miniatura = src ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={rotuloMidia(m.type, m.media_filename)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                {m.type === 'VIDEO' && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
                    <Play className="h-6 w-6" />
                  </span>
                )}
              </>
            ) : (
              // Video sem thumbnail para aqui (caso comum); imagem sem nenhuma
              // das duas urls nao deveria acontecer, mas o icone segura o tile.
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                {m.type === 'VIDEO' ? <Play className="h-6 w-6" /> : <ImageOff className="h-6 w-6" />}
              </div>
            );
            const selo = (
              <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
                {data(m.created_at)}
              </span>
            );
            const classe = 'group relative block aspect-square overflow-hidden rounded-md bg-muted';

            // Sem `media_url` nao ha o que abrir: tile morto, com aviso, em vez
            // de um link que leva a lugar nenhum.
            if (!m.media_url) {
              return (
                <div key={m.id} className={classe} title={`Arquivada · ${data(m.created_at)}`}>
                  {miniatura}
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                    arquivada
                  </span>
                  {selo}
                </div>
              );
            }

            return (
              <a
                key={m.id}
                href={m.media_url}
                target="_blank"
                rel="noreferrer"
                className={classe}
                title={data(m.created_at)}
              >
                {miniatura}
                {selo}
              </a>
            );
          })}
        </div>
      )}

      {arquivos.length > 0 && (
        <ul className="divide-y rounded-md border">
          {arquivos.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              {m.type === 'AUDIO' ? (
                <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {rotuloMidia(m.type, m.media_filename)}
              </span>
              {m.media_duration_seconds != null && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {duracao(m.media_duration_seconds)}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">{data(m.created_at)}</span>
              {m.media_url ? (
                <a
                  href={m.media_url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs underline"
                >
                  abrir
                </a>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">arquivada</span>
              )}
              <Link
                href={`/chat/${leadId}`}
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                chat
              </Link>
            </li>
          ))}
        </ul>
      )}

      {q.isError ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-xs text-destructive">Não foi possível carregar mais mídias.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={q.isFetching}
            onClick={() => void (q.hasNextPage ? q.fetchNextPage() : q.refetch())}
          >
            Tentar de novo
          </Button>
        </div>
      ) : (
        q.hasNextPage && (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </Button>
          </div>
        )
      )}
    </div>
  );
}
