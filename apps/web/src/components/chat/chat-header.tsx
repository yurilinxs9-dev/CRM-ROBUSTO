'use client';

import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  CheckCheck,
  Info,
  MoreVertical,
  Trash2,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ChatLead, ChatStage, formatPhone, getInitials } from './types';

/** "online" if interacted within 2min, else "visto por último há …". */
function presenceLabel(lead: ChatLead): string {
  if (!lead.ultima_interacao) return formatPhone(lead.telefone);
  const last = new Date(lead.ultima_interacao);
  if (Number.isNaN(last.getTime())) return formatPhone(lead.telefone);
  const ageMs = Date.now() - last.getTime();
  if (ageMs < 2 * 60_000) return 'online';
  try {
    return `visto por último há ${formatDistanceToNowStrict(last, { locale: ptBR })}`;
  } catch {
    return formatPhone(lead.telefone);
  }
}

interface ChatHeaderProps {
  lead: ChatLead;
  stages: ChatStage[];
  onStageChange: (stageId: string) => void;
  onOpenDetails: () => void;
  onMarkRead: () => void;
  onClearConversation: () => void;
  onDeleteLead: () => void;
}

export function ChatHeader({
  lead,
  stages,
  onStageChange,
  onOpenDetails,
  onMarkRead,
  onClearConversation,
  onDeleteLead,
}: ChatHeaderProps) {
  const router = useRouter();
  const presence = presenceLabel(lead);
  const isOnline = presence === 'online';

  return (
    <header
      className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/80"
      role="banner"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Voltar"
        onClick={() => {
          if (window.history.length > 1) {
            router.back();
          } else {
            router.push('/chat');
          }
        }}
        className="h-9 w-9"
      >
        <ArrowLeft size={18} />
      </Button>

      <Avatar className="h-10 w-10 flex-shrink-0">
        {lead.foto_url ? (
          <AvatarImage src={lead.foto_url} alt={lead.nome} />
        ) : null}
        <AvatarFallback className="bg-primary/15 text-primary font-semibold text-sm">
          {getInitials(lead.nome)}
        </AvatarFallback>
      </Avatar>

      <button
        type="button"
        onClick={onOpenDetails}
        className="flex min-w-0 flex-1 flex-col items-start text-left hover:opacity-90 focus:outline-none"
      >
        <span className="truncate text-sm font-semibold text-foreground">
          {lead.nome}
        </span>
        <span
          className={
            isOnline
              ? 'truncate text-[11px] font-medium text-green-600 dark:text-green-400'
              : 'truncate text-[11px] text-muted-foreground'
          }
        >
          {presence}
        </span>
      </button>

      <div className="flex items-center gap-2">
        <Select value={lead.estagio_id} onValueChange={onStageChange}>
          <SelectTrigger
            aria-label="Etapa do funil"
            className="h-8 w-[160px] text-xs"
          >
            <SelectValue placeholder="Etapa" />
          </SelectTrigger>
          <SelectContent>
            {stages.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: s.cor }}
                  />
                  {s.nome}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenDetails}
          className="hidden h-8 text-xs sm:inline-flex"
        >
          <Info size={14} className="mr-1.5" />
          Detalhes
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Mais opções"
              className="h-9 w-9"
            >
              <MoreVertical size={18} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onMarkRead}>
              <CheckCheck size={14} className="mr-2" />
              Marcar como lido
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenDetails} className="sm:hidden">
              <Info size={14} className="mr-2" />
              Detalhes do lead
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onClearConversation}>
              <Trash2 size={14} className="mr-2" />
              Limpar conversa
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDeleteLead}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 size={14} className="mr-2" />
              Excluir lead
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
