'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Trash2, Loader2, Check } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { api } from '@/lib/api';

export interface TagRow {
  id: string;
  nome: string;
  cor: string;
}

interface TagPickerProps {
  /** Nomes aplicados ao lead. É o que vai para `Lead.tags` (Json de strings). */
  value: string[];
  onChange: (next: string[]) => void;
}

const COR_PADRAO = '#3498DB';

/** Compara nome de tag do jeito que o usuário espera: sem diferenciar caixa. */
function mesmoNome(a: string, b: string) {
  return a.trim().toLocaleLowerCase('pt-BR') === b.trim().toLocaleLowerCase('pt-BR');
}

/**
 * Seletor de tags do lead.
 *
 * O catálogo (`GET /api/tags`) e o que está aplicado no lead (`Lead.tags`) são
 * coisas separadas no modelo: a tabela `Tag` guarda nome + cor por tenant, e o
 * lead guarda uma lista de strings. Este componente costura os dois — lista o
 * catálogo para escolher, resolve a cor pelo nome na hora de desenhar o chip, e
 * devolve para o formulário apenas os nomes.
 *
 * Por isso um chip pode existir sem estar no catálogo (tag digitada antes desta
 * tela, ou tag excluída depois de aplicada): nesse caso ele aparece com a cor
 * neutra, em vez de sumir da ficha do lead sem aviso.
 */
export function TagPicker({ value, onChange }: TagPickerProps) {
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [confirmandoExclusao, setConfirmandoExclusao] = useState<string | null>(null);

  const { data: catalogo = [], isLoading } = useQuery<TagRow[]>({
    queryKey: ['tags'],
    queryFn: async () => {
      const res = await api.get('/api/tags');
      return res.data as TagRow[];
    },
  });

  const corDe = (nome: string) =>
    catalogo.find((t) => mesmoNome(t.nome, nome))?.cor ?? null;

  const termo = busca.trim();

  const filtradas = useMemo(() => {
    if (!termo) return catalogo;
    const alvo = termo.toLocaleLowerCase('pt-BR');
    return catalogo.filter((t) => t.nome.toLocaleLowerCase('pt-BR').includes(alvo));
  }, [catalogo, termo]);

  // Só oferece criar quando o que foi digitado não existe exatamente. Sem isso,
  // "Criar" apareceria junto da própria tag que a busca acabou de encontrar.
  const podeCriar = termo.length > 0 && !catalogo.some((t) => mesmoNome(t.nome, termo));

  const criar = useMutation({
    mutationFn: async (nome: string) => {
      const res = await api.post('/api/tags', { nome, cor: COR_PADRAO });
      return res.data as TagRow;
    },
    onSuccess: (tag) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      aplicar(tag.nome);
      setBusca('');
    },
    onError: () => toast.error('Erro ao criar a tag.'),
  });

  const excluir = useMutation({
    mutationFn: async (tag: TagRow) => {
      await api.delete(`/api/tags/${tag.id}`);
      return tag;
    },
    onSuccess: (tag) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      // Sai também da seleção deste lead: manter aplicada uma tag que o usuário
      // acabou de excluir do catálogo deixaria um chip que ele não consegue
      // mais reencontrar na lista.
      onChange(value.filter((n) => !mesmoNome(n, tag.nome)));
      setConfirmandoExclusao(null);
      toast.success(`Tag "${tag.nome}" excluida.`);
    },
    onError: () => {
      setConfirmandoExclusao(null);
      toast.error('Erro ao excluir a tag.');
    },
  });

  function aplicar(nome: string) {
    if (value.some((n) => mesmoNome(n, nome))) return;
    onChange([...value, nome]);
  }

  function alternar(nome: string) {
    if (value.some((n) => mesmoNome(n, nome))) {
      onChange(value.filter((n) => !mesmoNome(n, nome)));
    } else {
      aplicar(nome);
    }
  }

  function remover(nome: string) {
    onChange(value.filter((n) => !mesmoNome(n, nome)));
  }

  function confirmarComEnter() {
    if (!podeCriar || criar.isPending) return;
    criar.mutate(termo);
  }

  return (
    <div className="space-y-2">
      {/* Chips aplicados */}
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((nome) => {
          const cor = corDe(nome);
          return (
            <span
              key={nome}
              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
              style={
                cor
                  ? { borderColor: cor, color: cor, backgroundColor: `${cor}1A` }
                  : undefined
              }
            >
              {nome}
              <button
                type="button"
                onClick={() => remover(nome)}
                className="opacity-60 transition-opacity hover:opacity-100"
                aria-label={`Remover tag ${nome}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <Popover open={aberto} onOpenChange={setAberto}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]">
              <Plus className="h-3 w-3" />
              Tag
            </Button>
          </PopoverTrigger>

          <PopoverContent align="start" className="w-72 p-0">
            <div className="border-b p-2">
              <Input
                autoFocus
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmarComEnter();
                  }
                }}
                placeholder="Buscar ou criar tag..."
                className="h-8 text-xs"
              />
            </div>

            <div className="max-h-64 overflow-y-auto p-1">
              {isLoading && (
                <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Carregando...
                </div>
              )}

              {!isLoading && filtradas.length === 0 && !podeCriar && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Nenhuma tag cadastrada.
                </p>
              )}

              {filtradas.map((tag) => {
                const aplicada = value.some((n) => mesmoNome(n, tag.nome));
                const confirmando = confirmandoExclusao === tag.id;

                if (confirmando) {
                  return (
                    <div
                      key={tag.id}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs"
                    >
                      <span className="truncate text-muted-foreground">
                        Excluir &quot;{tag.nome}&quot;?
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="h-6 px-2 text-[11px]"
                          disabled={excluir.isPending}
                          onClick={() => excluir.mutate(tag)}
                        >
                          {excluir.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            'Excluir'
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setConfirmandoExclusao(null)}
                        >
                          Cancelar
                        </Button>
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={tag.id}
                    className="group flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-accent"
                  >
                    <button
                      type="button"
                      onClick={() => alternar(tag.nome)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.cor }}
                      />
                      <span className="truncate text-xs">{tag.nome}</span>
                      {aplicada && <Check className="ml-auto h-3 w-3 shrink-0 text-primary" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmandoExclusao(tag.id)}
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      aria-label={`Excluir tag ${tag.nome}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {podeCriar && (
                <button
                  type="button"
                  onClick={() => criar.mutate(termo)}
                  disabled={criar.isPending}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-60"
                >
                  {criar.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  <span className="truncate">
                    Criar &quot;<span className="font-medium">{termo}</span>&quot;
                  </span>
                </button>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {value.length === 0 && (
        <p className="text-[11px] text-muted-foreground">Nenhuma tag neste lead.</p>
      )}
    </div>
  );
}
