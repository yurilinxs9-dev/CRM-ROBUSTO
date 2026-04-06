'use client';

import { Mail, Phone, Tag, User2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ChatLead, formatPhone, getInitials } from './types';

interface LeadDetailsSheetProps {
  lead: ChatLead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TEMP_LABEL: Record<string, string> = {
  FRIO: 'Frio',
  MORNO: 'Morno',
  QUENTE: 'Quente',
  MUITO_QUENTE: 'Muito Quente',
};

export function LeadDetailsSheet({
  lead,
  open,
  onOpenChange,
}: LeadDetailsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Detalhes do lead</SheetTitle>
          <SheetDescription>
            Informações do contato e do funil.
          </SheetDescription>
        </SheetHeader>

        {lead && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <Avatar className="h-20 w-20">
                <AvatarFallback className="bg-primary/15 text-primary text-xl font-semibold">
                  {getInitials(lead.nome)}
                </AvatarFallback>
              </Avatar>
              <div>
                <h3 className="text-lg font-semibold">{lead.nome}</h3>
                <p className="text-sm text-muted-foreground">
                  {formatPhone(lead.telefone)}
                </p>
              </div>
              <Badge variant="secondary">
                {TEMP_LABEL[lead.temperatura] ?? lead.temperatura}
              </Badge>
            </div>

            <Separator />

            <div className="space-y-3">
              <DetailRow
                icon={<Phone size={14} />}
                label="Telefone"
                value={formatPhone(lead.telefone)}
              />
              {lead.email && (
                <DetailRow
                  icon={<Mail size={14} />}
                  label="E-mail"
                  value={lead.email}
                />
              )}
              {lead.origem && (
                <DetailRow
                  icon={<Tag size={14} />}
                  label="Origem"
                  value={lead.origem}
                />
              )}
              {lead.responsavel?.nome && (
                <DetailRow
                  icon={<User2 size={14} />}
                  label="Responsável"
                  value={lead.responsavel.nome}
                />
              )}
              {lead.valor_estimado != null && (
                <DetailRow
                  label="Valor estimado"
                  value={
                    typeof lead.valor_estimado === 'number'
                      ? lead.valor_estimado.toLocaleString('pt-BR', {
                          style: 'currency',
                          currency: 'BRL',
                        })
                      : String(lead.valor_estimado)
                  }
                />
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface DetailRowProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
}

function DetailRow({ icon, label, value }: DetailRowProps) {
  return (
    <div className="flex items-start gap-3">
      {icon && (
        <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="break-words text-sm text-foreground">{value}</p>
      </div>
    </div>
  );
}
