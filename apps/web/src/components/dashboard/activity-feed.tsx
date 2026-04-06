'use client';

import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface ActivityItem {
  id: string;
  leadNome: string;
  action: string;
  operatorNome: string;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  lead_created: 'criou o lead',
  message_sent: 'enviou mensagem para',
  message_received: 'recebeu mensagem de',
  call_made: 'ligou para',
  stage_changed: 'moveu etapa de',
  note_added: 'adicionou nota em',
};

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
        Sem atividades recentes.
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-[360px] pr-2">
      <ul className="space-y-1">
        {items.slice(0, 10).map((act) => {
          const label = ACTION_LABELS[act.action] ?? act.action;
          const ago = formatDistanceToNow(new Date(act.createdAt), {
            addSuffix: true,
            locale: ptBR,
          });
          return (
            <li
              key={act.id}
              className="flex items-start gap-3 py-2 px-2 rounded-lg transition-colors hover:bg-[var(--bg-surface-3)]"
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-semibold"
                style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
              >
                {initials(act.operatorNome) || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs leading-snug" style={{ color: 'var(--text-primary)' }}>
                  <span className="font-semibold">{act.operatorNome}</span>{' '}
                  <span style={{ color: 'var(--text-muted)' }}>{label}</span>{' '}
                  <span className="font-medium">{act.leadNome}</span>
                </p>
                <p
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
                >
                  {ago}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
