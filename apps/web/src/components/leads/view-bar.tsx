'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Columns3, List, Plus, Save, SlidersHorizontal, Undo2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/stores/auth.store';
import { contarFiltrosAtivos } from '@/lib/lead-filters';
import {
  CONFIG_VAZIA,
  configIgual,
  fromSavedConfig,
  type LeadViewConfig,
} from '@/lib/lead-view-config';
import { CardFieldsMenu } from './card-fields-menu';
import { GESTORES, type UseLeadView } from './use-lead-view';

interface ViewBarProps {
  view: UseLeadView;
  /** Qual dos dois botões do toggle fica aceso — a tela onde a barra está. */
  mode: 'lista' | 'kanban';
  onOpenFilters: () => void;
}

/**
 * A barra que fica no topo da lista e do kanban.
 *
 * As duas telas são a MESMA view vista de dois jeitos, e o toggle Lista/Kanban
 * é só navegação entre rotas: quem carrega a escolha de view de um lado para o
 * outro é o localStorage lido pelo `useLeadView`, que roda nas duas. Por isso
 * são `Link` e não estado local — o usuário pode abrir o kanban numa aba nova e
 * cair na mesma view.
 *
 * Salvar / Descartar só aparecem com estado sujo. Botão que fica aceso o tempo
 * todo vira ruído e ensina o usuário a ignorar a barra; aparecendo só quando há
 * o que salvar, o próprio surgimento é o aviso de que a tela mudou.
 */
export function ViewBar({ view, mode, onOpenFilters }: ViewBarProps): JSX.Element {
  const meuRole = useAuthStore((s) => s.user?.role ?? '');
  const souGestor = GESTORES.includes(meuRole);

  const [dialogAberto, setDialogAberto] = useState(false);
  const [nomeNovo, setNomeNovo] = useState('');
  const [compartilhada, setCompartilhada] = useState(false);

  const { minhas, compartilhadas } = useMemo(
    () => ({
      minhas: view.views.filter((v) => v.user_id !== null),
      compartilhadas: view.views.filter((v) => v.user_id === null),
    }),
    [view.views],
  );

  const ativos = contarFiltrosAtivos(view.filters);

  const { activeView, config, setConfig } = view;

  /**
   * Sem view ativa, o `tipo_padrao` acompanha a tela onde a barra está.
   *
   * `CONFIG_VAZIA` nasce 'kanban', então salvar como nova a partir da lista
   * criaria uma view que abre em kanban — o usuário arrumou uma tabela e ganhou
   * um board. Com view ativa não encosta: ali o tipo é escolha salva, e sobrepor
   * seria a barra mexendo sozinha no que o usuário gravou.
   */
  useEffect(() => {
    if (activeView === null && config.tipo_padrao !== mode) {
      setConfig({ ...config, tipo_padrao: mode });
    }
  }, [activeView, config, mode, setConfig]);

  /** O "nada" desta tela — o vazio já com o tipo que o efeito acima aplica. */
  const vazioDaTela: LeadViewConfig = useMemo(
    () => ({ ...CONFIG_VAZIA, tipo_padrao: mode, colunas: [], card_fields: [] }),
    [mode],
  );

  // Sem view ativa `dirty` é sempre false (não há linha para comparar), mas
  // continua fazendo sentido virar view o que está na tela — é assim que a
  // primeira view de alguém nasce.
  const podeVirarView =
    view.dirty ||
    (view.activeView === null && (ativos > 0 || !configIgual(view.config, vazioDaTela)));

  const abrirDialog = () => {
    setNomeNovo(view.activeView ? `${view.activeView.nome} (cópia)` : '');
    setCompartilhada(false);
    setDialogAberto(true);
  };

  const confirmarSalvarComo = () => {
    if (!nomeNovo.trim()) return;
    view.saveAs(nomeNovo.trim(), souGestor && compartilhada);
    setDialogAberto(false);
  };

  const linkToggle = (ativo: boolean) =>
    cn(
      'flex h-8 w-9 items-center justify-center transition-colors first:rounded-l-[5px] last:rounded-r-[5px]',
      ativo ? 'bg-accent' : 'hover:bg-accent/60',
    );

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
      style={{ borderColor: 'var(--border-default)' }}
    >
      {/* ============== Seletor de view ============== */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 max-w-[240px] gap-1.5 px-2">
            <span className="truncate text-sm font-medium">
              {view.activeView?.nome ?? 'Sem view'}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="min-w-[240px]">
          <DropdownMenuCheckboxItem
            checked={view.activeView === null}
            onCheckedChange={() => {
              if (view.activeView !== null) view.selectView(null);
            }}
          >
            Sem view
          </DropdownMenuCheckboxItem>

          {minhas.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Minhas
              </DropdownMenuLabel>
              {minhas.map((v) => (
                <DropdownMenuCheckboxItem
                  key={v.id}
                  checked={v.id === view.activeView?.id}
                  onCheckedChange={() => {
                    // Reselecionar a ativa jogaria fora a edição em curso sem o
                    // usuário pedir; para isso existe "Descartar".
                    if (v.id !== view.activeView?.id) view.selectView(v.id);
                  }}
                >
                  <span className="truncate">{v.nome}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}

          {compartilhadas.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Compartilhadas
              </DropdownMenuLabel>
              {compartilhadas.map((v) => (
                <DropdownMenuCheckboxItem
                  key={v.id}
                  checked={v.id === view.activeView?.id}
                  onCheckedChange={() => {
                    if (v.id !== view.activeView?.id) view.selectView(v.id);
                  }}
                >
                  <span className="truncate">{v.nome}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}

          {view.views.length === 0 && (
            <div className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              Nenhuma view salva ainda.
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ============== Lista / Kanban ============== */}
      <div
        className="flex items-center overflow-hidden rounded-md border"
        style={{ borderColor: 'var(--border-default)' }}
      >
        <Link
          href="/leads"
          aria-label="Ver como lista"
          aria-current={mode === 'lista' ? 'page' : undefined}
          title="Lista"
          className={linkToggle(mode === 'lista')}
          style={{ color: mode === 'lista' ? 'var(--text-primary)' : 'var(--text-muted)' }}
        >
          <List className="h-4 w-4" />
        </Link>
        <Link
          href="/kanban"
          aria-label="Ver como kanban"
          aria-current={mode === 'kanban' ? 'page' : undefined}
          title="Kanban"
          className={linkToggle(mode === 'kanban')}
          style={{ color: mode === 'kanban' ? 'var(--text-primary)' : 'var(--text-muted)' }}
        >
          <Columns3 className="h-4 w-4" />
        </Link>
      </div>

      {/* ============== Filtros ============== */}
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onOpenFilters}>
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filtros
        {ativos > 0 && (
          <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {ativos}
          </span>
        )}
      </Button>

      {mode === 'kanban' && (
        <CardFieldsMenu
          value={view.config.card_fields}
          onChange={(fields) =>
            view.setConfig(fromSavedConfig({ ...view.config, card_fields: fields }))
          }
        />
      )}

      {/* ============== Estado sujo ============== */}
      {podeVirarView && (
        <div className="ml-auto flex items-center gap-1.5">
          {view.dirty && (
            <span className="hidden text-xs sm:inline" style={{ color: 'var(--text-muted)' }}>
              Alterações não salvas
            </span>
          )}

          {view.dirty && view.canEditActive && (
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={view.save}>
              <Save className="h-3.5 w-3.5" />
              Salvar
            </Button>
          )}

          {view.dirty && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={view.discard}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Descartar
            </Button>
          )}

          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={abrirDialog}>
            <Plus className="h-3.5 w-3.5" />
            Salvar como nova
          </Button>
        </div>
      )}

      <Dialog open={dialogAberto} onOpenChange={setDialogAberto}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Salvar como nova view</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="view-bar-nome" className="text-xs">
                Nome
              </Label>
              <Input
                id="view-bar-nome"
                autoFocus
                value={nomeNovo}
                onChange={(e) => setNomeNovo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmarSalvarComo();
                  }
                }}
                placeholder="Ex.: Quentes sem tarefa"
                className="h-8 text-xs"
              />
            </div>

            {/* Só gestor cria view do time — o backend recusa com 403 de todo
                jeito, e oferecer a opção a quem vai levar erro é pior que não
                oferecer. */}
            {souGestor && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={compartilhada}
                  onChange={(e) => setCompartilhada(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                Compartilhada com o time
              </label>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setDialogAberto(false)}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!nomeNovo.trim()}
              onClick={confirmarSalvarComo}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
