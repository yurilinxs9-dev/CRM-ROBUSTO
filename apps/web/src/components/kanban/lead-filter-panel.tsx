'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, X, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { api } from '@/lib/api';
import {
  FILTROS_VAZIOS,
  ORIGENS,
  contarFiltrosAtivos,
  fromSaved,
  type LeadPanelFilters,
} from '@/lib/lead-filters';

export interface TagComContagem {
  id: string;
  nome: string;
  cor: string;
  total: number;
}

export interface LeadView {
  id: string;
  nome: string;
  filtros: unknown;
  /** null = compartilhada com o tenant. */
  user_id: string | null;
}

interface Props {
  value: LeadPanelFilters;
  onChange: (next: LeadPanelFilters) => void;
}

/**
 * Painel de filtros da lista de leads.
 *
 * Os critérios daqui são aplicados NO SERVIDOR (viram query params de
 * `/api/leads`). Isso é o ponto do componente: a busca por texto do topo do
 * kanban filtra no cliente, sobre os leads já baixados, e como o board carrega
 * em janela por coluna, num pipeline de 2.400 leads ela responde só sobre o
 * pedaço carregado. Um filtro que erra sem avisar é pior que nenhum — por isso
 * estes vão ao banco.
 */
export function LeadFilterPanel({ value, onChange }: Props) {
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [buscaTag, setBuscaTag] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [nomeNovaView, setNomeNovaView] = useState('');

  const { data: views = [] } = useQuery<LeadView[]>({
    queryKey: ['lead-views'],
    queryFn: async () => {
      const res = await api.get('/api/lead-views');
      return res.data as LeadView[];
    },
    enabled: aberto,
  });

  const criarView = useMutation({
    mutationFn: async (nome: string) => {
      // Grava o filtro que está na tela AGORA — é o que "salvar filtro atual"
      // promete, e o que o usuário tem na frente ao clicar.
      const res = await api.post('/api/lead-views', { nome, filtros: value });
      return res.data as LeadView;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-views'] });
      setSalvando(false);
      setNomeNovaView('');
      toast.success('Filtro salvo.');
    },
    onError: () => toast.error('Erro ao salvar o filtro.'),
  });

  const excluirView = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/lead-views/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-views'] });
      toast.success('Filtro excluido.');
    },
    onError: () => toast.error('Erro ao excluir o filtro.'),
  });

  const { data: tags = [], isLoading } = useQuery<TagComContagem[]>({
    queryKey: ['tags', 'com-contagem'],
    queryFn: async () => {
      const res = await api.get('/api/tags', { params: { with_counts: '1' } });
      return res.data as TagComContagem[];
    },
    enabled: aberto,
  });

  const termo = buscaTag.trim().toLocaleLowerCase('pt-BR');
  const tagsFiltradas = useMemo(
    () => (termo ? tags.filter((t) => t.nome.toLocaleLowerCase('pt-BR').includes(termo)) : tags),
    [tags, termo],
  );

  const ativos = contarFiltrosAtivos(value);

  const set = (patch: Partial<LeadPanelFilters>) => onChange({ ...value, ...patch });

  const alternarTag = (nome: string) => {
    const jaTem = value.tags.includes(nome);
    set({ tags: jaTem ? value.tags.filter((t) => t !== nome) : [...value.tags, nome] });
  };

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filtros
          {ativos > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {ativos}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold">Filtrar leads</span>
          {ativos > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onChange(FILTROS_VAZIOS)}
            >
              Limpar
            </Button>
          )}
        </div>

        <div className="scrollbar-thin max-h-[70vh] overflow-y-auto overscroll-contain">
          {/* ---- Filtros salvos ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Filtros salvos
            </Label>

            {views.length === 0 && !salvando && (
              <p className="text-xs text-muted-foreground">Nenhum filtro salvo ainda.</p>
            )}

            <div className="space-y-1">
              {views.map((v) => (
                <div
                  key={v.id}
                  className="group flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent"
                >
                  <button
                    type="button"
                    onClick={() => onChange(fromSaved(v.filtros))}
                    className="min-w-0 flex-1 truncate text-left text-xs"
                  >
                    {v.nome}
                    {v.user_id === null && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(equipe)</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => excluirView.mutate(v.id)}
                    disabled={excluirView.isPending}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    aria-label={`Excluir filtro ${v.nome}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>

            {salvando ? (
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={nomeNovaView}
                  onChange={(e) => setNomeNovaView(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (nomeNovaView.trim()) criarView.mutate(nomeNovaView.trim());
                    } else if (e.key === 'Escape') {
                      setSalvando(false);
                    }
                  }}
                  placeholder="Nome do filtro"
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!nomeNovaView.trim() || criarView.isPending}
                  onClick={() => criarView.mutate(nomeNovaView.trim())}
                >
                  {criarView.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Salvar'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSalvando(false)}
                >
                  Cancelar
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-[11px]"
                disabled={ativos === 0}
                onClick={() => {
                  setNomeNovaView('');
                  setSalvando(true);
                }}
                // Salvar filtro vazio criaria uma view que não filtra nada — o
                // usuário clicaria nela depois esperando um recorte.
                title={ativos === 0 ? 'Escolha ao menos um critério para salvar' : undefined}
              >
                Salvar filtro atual
              </Button>
            )}
          </div>

          {/* ---- Tags ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Tags
            </Label>
            <Input
              value={buscaTag}
              onChange={(e) => setBuscaTag(e.target.value)}
              placeholder="Localizar tags"
              className="h-8 text-xs"
            />

            {isLoading && (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Carregando...
              </div>
            )}

            {!isLoading && tagsFiltradas.length === 0 && (
              <p className="py-3 text-xs text-muted-foreground">
                {tags.length === 0 ? 'Nenhuma tag cadastrada.' : 'Nenhuma tag encontrada.'}
              </p>
            )}

            <div className="flex flex-wrap gap-1">
              {tagsFiltradas.map((tag) => {
                const marcada = value.tags.includes(tag.nome);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => alternarTag(tag.nome)}
                    className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-opacity"
                    style={{
                      borderColor: tag.cor,
                      color: marcada ? '#fff' : tag.cor,
                      backgroundColor: marcada ? tag.cor : `${tag.cor}1A`,
                    }}
                  >
                    {tag.nome}
                    <span className="opacity-70">{tag.total}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ---- Período de criação ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Criado entre
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={value.created_from}
                onChange={(e) => set({ created_from: e.target.value })}
                className="h-8 text-xs"
              />
              <span className="text-xs text-muted-foreground">até</span>
              <Input
                type="date"
                value={value.created_to}
                onChange={(e) => set({ created_to: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* ---- Valor estimado ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Valor estimado
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="decimal"
                value={value.valor_min}
                onChange={(e) => set({ valor_min: e.target.value })}
                placeholder="min"
                className="h-8 text-xs"
              />
              <span className="text-xs text-muted-foreground">—</span>
              <Input
                type="number"
                inputMode="decimal"
                value={value.valor_max}
                onChange={(e) => set({ valor_max: e.target.value })}
                placeholder="max"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* ---- Origem (o "Lead fonte" do Kommo) ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Origem
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {ORIGENS.map(([valor, rotulo]) => (
                <Button
                  key={valor}
                  type="button"
                  variant={value.origem.includes(valor) ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    set({
                      origem: value.origem.includes(valor)
                        ? value.origem.filter((o) => o !== valor)
                        : [...value.origem, valor],
                    })
                  }
                >
                  {rotulo}
                </Button>
              ))}
            </div>
          </div>

          {/* ---- Próximo agendamento ---- */}
          <div className="space-y-2 border-b p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Próximo agendamento
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={value.followup_from}
                onChange={(e) => set({ followup_from: e.target.value })}
                className="h-8 text-xs"
              />
              <span className="text-xs text-muted-foreground">até</span>
              <Input
                type="date"
                value={value.followup_to}
                onChange={(e) => set({ followup_to: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* ---- Tarefas ---- */}
          <div className="space-y-2 p-3">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Tarefas
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['sem', 'Sem tarefas'],
                  ['atrasada', 'Tarefas atrasadas'],
                ] as const
              ).map(([chave, rotulo]) => (
                <Button
                  key={chave}
                  type="button"
                  variant={value.tarefa === chave ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => set({ tarefa: value.tarefa === chave ? '' : chave })}
                >
                  {rotulo}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {ativos > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
            {value.tags.map((nome) => (
              <span
                key={nome}
                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
              >
                {nome}
                <button type="button" onClick={() => alternarTag(nome)} aria-label={`Tirar ${nome}`}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
