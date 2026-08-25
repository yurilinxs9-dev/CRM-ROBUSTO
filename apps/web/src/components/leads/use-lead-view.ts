'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import {
  FILTROS_VAZIOS,
  fromSaved,
  type LeadPanelFilters,
} from '@/lib/lead-filters';
import {
  CONFIG_VAZIA,
  configIgual,
  fromSavedConfig,
  type LeadViewConfig,
} from '@/lib/lead-view-config';

/** A linha de `LeadView` como o backend devolve: config no topo, não aninhada. */
export interface LeadViewDto {
  id: string;
  nome: string;
  /** null = compartilhada com o tenant inteiro. */
  user_id: string | null;
  filtros: unknown;
  tipo_padrao: string;
  sort: unknown;
  colunas: unknown;
  card_fields: unknown;
}

export interface UseLeadView {
  views: LeadViewDto[];
  /** null = nenhuma view aplicada (filtros e config zerados). */
  activeView: LeadViewDto | null;
  selectView: (id: string | null) => void;
  filters: LeadPanelFilters;
  setFilters: (f: LeadPanelFilters) => void;
  config: LeadViewConfig;
  setConfig: (c: LeadViewConfig) => void;
  dirty: boolean;
  save: () => void;
  saveAs: (nome: string, compartilhada: boolean) => void;
  discard: () => void;
  canEditActive: boolean;
}

/** Quem pode escrever em view sem dono. Espelha o guard do backend (só UI). */
export const GESTORES: readonly string[] = ['GERENTE', 'SUPER_ADMIN'];

/**
 * Qual view estava aberta. Fica no localStorage, e não na URL, porque é
 * preferência de tela e não recorte compartilhável: é o que faz a view
 * sobreviver ao pulo entre `/leads` e `/kanban`, que são duas rotas diferentes
 * com o mesmo hook rodando dentro.
 */
const CHAVE_STORAGE = 'crm.leadView';

/** Referência estável: `data ?? []` novo a cada render invalidaria todo memo. */
const SEM_VIEWS: LeadViewDto[] = [];

function lerViewSalva(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(CHAVE_STORAGE);
  } catch {
    // Modo privado / storage bloqueado: a tela abre sem view, e é só isso.
    return null;
  }
}

function gravarViewSalva(id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(CHAVE_STORAGE, id);
    else window.localStorage.removeItem(CHAVE_STORAGE);
  } catch {
    // idem: perder a preferência é aceitável, derrubar a tela não.
  }
}

/**
 * A view ativa e o estado sujo de cima dela.
 *
 * O ponto do hook é a distinção entre "o que está salvo" (a linha da view) e "o
 * que está na tela agora" (`filters`/`config`). O usuário mexe à vontade sem
 * gravar nada; `dirty` é justamente a diferença entre os dois, e é ele que
 * acende os botões Salvar / Descartar. Sem essa separação, arrastar uma coluna
 * escreveria no banco a cada pixel — e uma view compartilhada mudaria debaixo do
 * time inteiro sem ninguém pedir.
 *
 * A comparação é sobre valores hidratados dos DOIS lados (`fromSaved` /
 * `fromSavedConfig`), nunca sobre o Json cru: o banco guarda o que outra versão
 * do cliente gravou, e comparar cru daria "sujo" eterno em view antiga.
 */
export function useLeadView(): UseLeadView {
  const queryClient = useQueryClient();
  const meuId = useAuthStore((s) => s.user?.id ?? null);
  const meuRole = useAuthStore((s) => s.user?.role ?? '');

  const { data, isSuccess } = useQuery<LeadViewDto[]>({
    // Mesma queryKey do lead-filter-panel: uma view salva lá aparece aqui sem
    // request extra, e o invalidate de um atualiza o outro.
    queryKey: ['lead-views'],
    queryFn: async () => {
      const res = await api.get('/api/lead-views');
      return res.data as LeadViewDto[];
    },
  });
  const views = data ?? SEM_VIEWS;

  const [activeViewId, setActiveViewId] = useState<string | null>(() => lerViewSalva());
  const [filters, setFilters] = useState<LeadPanelFilters>(FILTROS_VAZIOS);
  const [config, setConfig] = useState<LeadViewConfig>(CONFIG_VAZIA);

  /**
   * Id já hidratado a partir de uma linha real. Serve para dois julgamentos que
   * o `activeViewId` sozinho não distingue: não re-hidratar (o que apagaria a
   * edição em curso a cada refetch) e saber se a view SUMIU (estava aqui) ou
   * NUNCA ESTEVE (id velho no localStorage, ou linha recém-criada).
   */
  const hidratadoRef = useRef<string | null>(null);

  const activeView = useMemo(
    () => (activeViewId ? views.find((v) => v.id === activeViewId) ?? null : null),
    [views, activeViewId],
  );

  /** Aplica uma linha (ou o vazio) na tela: id, storage e estado, de uma vez. */
  const aplicar = useCallback((view: LeadViewDto | null) => {
    const id = view?.id ?? null;
    setActiveViewId(id);
    gravarViewSalva(id);
    hidratadoRef.current = id;
    setFilters(view ? fromSaved(view.filtros) : FILTROS_VAZIOS);
    // A DTO carrega tipo_padrao/sort/colunas/card_fields no topo; fromSavedConfig
    // lê só as chaves que conhece, então dá para passar a view inteira.
    setConfig(view ? fromSavedConfig(view) : CONFIG_VAZIA);
  }, []);

  // Id que não está na lista carregada não tem o que aplicar — cai no vazio, o
  // mesmo destino que o efeito dá para um id morto vindo do localStorage.
  const selectView = useCallback(
    (id: string | null) => aplicar(id ? views.find((v) => v.id === id) ?? null : null),
    [aplicar, views],
  );

  useEffect(() => {
    if (!isSuccess || activeViewId === null) return;

    const view = views.find((v) => v.id === activeViewId);
    if (view) {
      if (hidratadoRef.current !== activeViewId) aplicar(view);
      return;
    }

    // A lista chegou e a view não está nela. Se ela já tinha sido hidratada,
    // alguém apagou enquanto esta aba estava aberta e o usuário precisa saber
    // por que a tela zerou. Se nunca esteve, é só um id velho no localStorage —
    // limpar em silêncio.
    if (hidratadoRef.current === activeViewId) toast('View removida');
    aplicar(null);
  }, [isSuccess, views, activeViewId, aplicar]);

  const dirty = useMemo(() => {
    // Sem view ativa não há o que comparar nem onde salvar — `saveAs` continua
    // sendo o caminho para virar view.
    if (!activeView) return false;
    if (!configIgual(config, fromSavedConfig(activeView))) return true;
    return JSON.stringify(filters) !== JSON.stringify(fromSaved(activeView.filtros));
  }, [activeView, config, filters]);

  const canEditActive = useMemo(() => {
    if (!activeView) return false;
    if (activeView.user_id === null) return GESTORES.includes(meuRole);
    return activeView.user_id === meuId;
  }, [activeView, meuId, meuRole]);

  /**
   * Troca a linha no cache pelo que o servidor devolveu, ANTES do refetch.
   *
   * O backend sanitiza o corpo (coluna de campo que não existe mais some, sort
   * fora da whitelist vira {}), então a linha gravada pode não ser byte a byte o
   * que foi enviado. Adotar a resposta é o que faz `dirty` apagar de imediato —
   * comparar o estado local com a linha ANTIGA do cache deixaria a barra piscando
   * "não salvo" até o refetch chegar.
   */
  const trocarNoCache = useCallback(
    (view: LeadViewDto) => {
      queryClient.setQueryData<LeadViewDto[]>(['lead-views'], (antigas) => {
        const lista = antigas ?? [];
        return lista.some((v) => v.id === view.id)
          ? lista.map((v) => (v.id === view.id ? view : v))
          : [...lista, view];
      });
      void queryClient.invalidateQueries({ queryKey: ['lead-views'] });
      aplicar(view);
    },
    [aplicar, queryClient],
  );

  /** `sort` null vira {} — é como o backend guarda "sem ordenação". */
  const corpoConfig = useCallback(
    (c: LeadViewConfig) => ({ ...c, sort: c.sort ?? {} }),
    [],
  );

  const salvar = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.patch(`/api/lead-views/${id}`, {
        // O painel já fala a língua do backend: o service descarta chave que não
        // conhece e valor vazio, então o objeto vai direto.
        filtros: filters,
        ...corpoConfig(config),
      });
      return res.data as LeadViewDto;
    },
    onSuccess: (view) => {
      trocarNoCache(view);
      toast.success('View salva.');
    },
    onError: () => toast.error('Erro ao salvar a view.'),
  });

  const salvarComo = useMutation({
    mutationFn: async (args: { nome: string; compartilhada: boolean }) => {
      const res = await api.post('/api/lead-views', {
        nome: args.nome,
        compartilhada: args.compartilhada,
        filtros: filters,
        ...corpoConfig(config),
      });
      return res.data as LeadViewDto;
    },
    onSuccess: (view) => {
      trocarNoCache(view);
      toast.success('View criada.');
    },
    onError: () => toast.error('Erro ao criar a view.'),
  });

  const save = useCallback(() => {
    if (!activeView || !canEditActive || salvar.isPending) return;
    salvar.mutate(activeView.id);
  }, [activeView, canEditActive, salvar]);

  const saveAs = useCallback(
    (nome: string, compartilhada: boolean) => {
      const limpo = nome.trim();
      if (!limpo || salvarComo.isPending) return;
      salvarComo.mutate({ nome: limpo, compartilhada });
    },
    [salvarComo],
  );

  const discard = useCallback(() => {
    if (activeView) aplicar(activeView);
  }, [activeView, aplicar]);

  return {
    views,
    activeView,
    selectView,
    filters,
    setFilters,
    config,
    setConfig,
    dirty,
    save,
    saveAs,
    discard,
    canEditActive,
  };
}
