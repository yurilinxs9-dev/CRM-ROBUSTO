'use client';

/**
 * Palette global Ctrl+K (rodada Twenty item 2). Montada UMA vez no layout
 * do dashboard. Abre por Ctrl/Cmd+K ou pelo CustomEvent 'abrir-palette'
 * (disparado pelo campo de busca do topbar) — evento em vez de store:
 * dois pontos de abertura não justificam estado compartilhado novo.
 * shouldFilter={false}: a seção Leads já vem filtrada do servidor; as
 * seções estáticas são filtradas na mão (filtro simples por substring).
 *
 * Substitui a paleta antiga (`components/command-palette.tsx`, Onda 4), que
 * só tinha leads + navegação — duas paletas ouvindo Ctrl+K abririam as duas.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, Bookmark, CalendarDays, Kanban, LayoutDashboard, List, MessageSquare,
  Megaphone, Plus, Settings, Shield, Smartphone, User, type LucideIcon,
} from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

/**
 * O que `GET /api/leads` devolve nesta chamada. Sem `per_stage`+`pipeline_id` o
 * serviço responde um ARRAY puro de leads (leads.service.ts, `result = leads.map(mapRow)`);
 * o formato `{ leads, stage_counts }` é exclusivo do kanban janelado.
 */
interface LeadResult {
  id: string;
  nome: string;
  telefone: string;
}

/** Linha de `LeadView` como o backend devolve — mesmo shape do `useLeadView`. */
interface ViewResult {
  id: string;
  nome: string;
  /** 'lista' | 'kanban' (o backend normaliza qualquer outro valor para 'kanban'). */
  tipo_padrao: string;
}

interface ItemNav {
  rotulo: string;
  href: string;
  Icone: LucideIcon;
  /**
   * Quem enxerga o atalho. Espelha o filtro do sidebar: sem isso a palette
   * viraria porta dos fundos para tela que o menu esconde do mesmo usuário.
   */
  visivel?: (role: string | undefined) => boolean;
}

const NAVEGACAO: ReadonlyArray<ItemNav> = [
  { rotulo: 'Dashboard', href: '/dashboard', Icone: LayoutDashboard },
  { rotulo: 'Analytics', href: '/analytics', Icone: BarChart3 },
  { rotulo: 'Kanban', href: '/kanban', Icone: Kanban },
  { rotulo: 'Leads', href: '/leads', Icone: List },
  { rotulo: 'Conversas', href: '/chat', Icone: MessageSquare, visivel: (r) => r !== 'VISUALIZADOR' },
  {
    rotulo: 'Follow-up IA',
    href: '/followup',
    Icone: Megaphone,
    visivel: (r) => r === 'SUPER_ADMIN' || r === 'GERENTE',
  },
  { rotulo: 'Agenda', href: '/agenda', Icone: CalendarDays },
  { rotulo: 'Instâncias', href: '/instances', Icone: Smartphone },
  { rotulo: 'Configurações', href: '/settings', Icone: Settings },
  { rotulo: 'Admin', href: '/admin', Icone: Shield, visivel: (r) => r === 'SUPER_ADMIN' },
];

/** Chave lida pelo `useLeadView` na montagem — precisa bater exatamente. */
const CHAVE_VIEW = 'crm.leadView';

const contem = (texto: string, filtro: string) =>
  !filtro || texto.toLowerCase().includes(filtro);

export function CommandPalette(): JSX.Element {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const [busca, setBusca] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const aoAbrir = () => setOpen(true);
    window.addEventListener('keydown', aoTeclar);
    window.addEventListener('abrir-palette', aoAbrir);
    return () => {
      window.removeEventListener('keydown', aoTeclar);
      window.removeEventListener('abrir-palette', aoAbrir);
    };
  }, []);

  // Limpa a busca ao fechar, pra reabrir sempre neutro.
  useEffect(() => {
    if (!open) {
      setBusca('');
      setDebounced('');
    }
  }, [open]);

  // Só a busca de LEAD é debounced (ela vai ao servidor). O filtro das seções
  // estáticas roda sobre `busca` crua — filtrar em memória com 300ms de atraso
  // só faria a lista parecer travada.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca.trim()), 300);
    return () => clearTimeout(t);
  }, [busca]);

  const { data: leads = [], isFetching } = useQuery<LeadResult[]>({
    queryKey: ['palette-search', debounced],
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
    queryFn: async () => {
      const { data } = await api.get<LeadResult[]>('/api/leads', {
        params: { search: debounced, limit: 8 },
      });
      return Array.isArray(data) ? data : [];
    },
  });

  // Mesma queryKey do `useLeadView`/`lead-filter-panel`: aproveita o cache deles
  // e um invalidate de lá atualiza a palette de graça.
  const { data: views = [] } = useQuery<ViewResult[]>({
    queryKey: ['lead-views'],
    enabled: open,
    queryFn: async () => {
      const { data } = await api.get<ViewResult[]>('/api/lead-views');
      return Array.isArray(data) ? data : [];
    },
  });

  const ir = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const ativarView = (view: ViewResult) => {
    try {
      localStorage.setItem(CHAVE_VIEW, view.id);
    } catch {
      // storage indisponível: navega mesmo assim, sem view ativa
    }
    ir(view.tipo_padrao === 'lista' ? '/leads' : '/kanban');
  };

  const filtro = busca.trim().toLowerCase();
  const navegacaoVisivel = useMemo(
    () => NAVEGACAO.filter((n) => (!n.visivel || n.visivel(role)) && contem(n.rotulo, filtro)),
    [role, filtro],
  );
  const viewsVisiveis = useMemo(
    () => views.filter((v) => contem(v.nome, filtro)),
    [views, filtro],
  );
  const mostrarNovoLead = contem('novo lead', filtro);
  const buscandoLeads = isFetching && leads.length === 0;
  const nadaEncontrado =
    leads.length === 0 &&
    navegacaoVisivel.length === 0 &&
    viewsVisiveis.length === 0 &&
    !mostrarNovoLead &&
    !buscandoLeads;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput placeholder="Buscar lead, tela, view ou ação..." value={busca} onValueChange={setBusca} />
      <CommandList>
        {nadaEncontrado && <CommandEmpty>Nada encontrado.</CommandEmpty>}
        {buscandoLeads && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Buscando leads...</div>
        )}
        {leads.length > 0 && (
          <>
            <CommandGroup heading="Leads">
              {leads.map((lead) => (
                <CommandItem key={lead.id} value={`lead-${lead.id}`} onSelect={() => ir(`/chat/${lead.id}`)}>
                  <User className="h-4 w-4 opacity-70" />
                  <span className="truncate">{lead.nome || lead.telefone || 'Sem nome'}</span>
                  {lead.nome && lead.telefone && (
                    <span className="ml-auto text-xs text-muted-foreground">{lead.telefone}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        {navegacaoVisivel.length > 0 && (
          <CommandGroup heading="Navegação">
            {navegacaoVisivel.map(({ rotulo, href, Icone }) => (
              <CommandItem key={href} value={`nav-${href}`} onSelect={() => ir(href)}>
                <Icone className="h-4 w-4 opacity-70" />
                {rotulo}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {viewsVisiveis.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Views salvas">
              {viewsVisiveis.map((view) => (
                <CommandItem key={view.id} value={`view-${view.id}`} onSelect={() => ativarView(view)}>
                  <Bookmark className="h-4 w-4 opacity-70" />
                  <span className="truncate">{view.nome}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {view.tipo_padrao === 'lista' ? 'Lista' : 'Kanban'}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {mostrarNovoLead && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Ações">
              <CommandItem value="acao-novo-lead" onSelect={() => ir('/kanban?novo=1')}>
                <Plus className="h-4 w-4 opacity-70" />
                Novo lead
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
