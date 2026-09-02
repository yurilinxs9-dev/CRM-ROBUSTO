'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Bell,
  CheckSquare,
  MessageCircle,
  NotebookPen,
  Pencil,
  Plus,
} from 'lucide-react';
import { rotuloAtividade } from '@/lib/activity-label';
import {
  rotuloLembrete,
  rotuloSessao,
  rotuloTarefa,
  type TimelineItem,
} from '@/lib/lead-timeline-view';
import { cn } from '@/lib/cn';

const hora = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function iconeAtividade(subtipo: string) {
  switch (subtipo) {
    case 'stage_change':
      return <ArrowRight className="h-3.5 w-3.5" />;
    case 'task_created':
      return <CheckSquare className="h-3.5 w-3.5" />;
    case 'lead_updated':
      return <Pencil className="h-3.5 w-3.5" />;
    case 'lead_created':
      return <Plus className="h-3.5 w-3.5" />;
    default:
      return <Activity className="h-3.5 w-3.5" />;
  }
}

/** Destaca `@Nome` das pessoas mencionadas dentro do texto da nota. */
function comMencoes(texto: string, nomes: string[]): ReactNode {
  if (nomes.length === 0) return texto;
  const re = new RegExp(
    `@(${nomes.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  const partes = texto.split(re);
  return partes.map((p, i) =>
    i % 2 === 1 ? (
      <span key={i} className="rounded bg-amber-400/20 px-0.5 font-medium">
        @{p}
      </span>
    ) : (
      p
    ),
  );
}

export function TimelineItemView({ item, leadId }: { item: TimelineItem; leadId: string }) {
  const bolinha = (cls: string, icone: ReactNode) => (
    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', cls)}>
      {icone}
    </span>
  );

  switch (item.tipo) {
    case 'sessao':
      return (
        <li className="flex gap-3">
          {bolinha('bg-emerald-500/15 text-emerald-500', <MessageCircle className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloSessao(item)}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.ultima_direcao === 'INCOMING' ? 'Cliente: ' : 'Você: '}
              {item.preview ? item.preview : <span className="italic">(sem texto)</span>}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {item.recebidas} recebidas · {item.enviadas} enviadas · {item.instancia} ·{' '}
              {/* Sem ancora de mensagem: o chat nao rola ate um id. */}
              <Link href={`/chat/${leadId}`} className="underline-offset-2 hover:underline">
                abrir no chat
              </Link>
            </p>
          </div>
        </li>
      );
    case 'nota':
      return (
        <li className="flex gap-3">
          {bolinha('bg-amber-400/15 text-amber-500', <NotebookPen className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-sm italic">
                {comMencoes(
                  item.conteudo,
                  item.mencoes.map((m) => m.nome),
                )}
              </p>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}
              {item.autor ? ` · ${item.autor.nome}` : ''}
            </p>
          </div>
        </li>
      );
    case 'tarefa':
      return (
        <li className="flex gap-3">
          {bolinha('bg-sky-500/15 text-sky-500', <CheckSquare className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloTarefa(item)}</p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}
              {item.responsavel ? ` · ${item.responsavel.nome}` : ''} · {item.status}
            </p>
          </div>
        </li>
      );
    case 'lembrete':
      return (
        <li className="flex gap-3">
          {bolinha('bg-violet-500/15 text-violet-500', <Bell className="h-3.5 w-3.5" />)}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloLembrete(item)}</p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              avisar em {new Date(item.avisar_em).toLocaleDateString('pt-BR')} · {item.status}
            </p>
          </div>
        </li>
      );
    case 'atividade':
      return (
        <li className="flex gap-3">
          {bolinha('bg-muted text-muted-foreground', iconeAtividade(item.subtipo))}
          <div className="min-w-0 flex-1 pb-4">
            <p className="text-xs font-medium">{rotuloAtividade(item.subtipo)}</p>
            {item.descricao && (
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.descricao}</p>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {hora(item.quando)}
              {item.autor ? ` · ${item.autor.nome}` : ''}
            </p>
          </div>
        </li>
      );
  }
}
