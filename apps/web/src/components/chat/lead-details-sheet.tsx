'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, UserRound } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { FieldGroupView } from '@/components/fields/field-group-list';
import type { FieldSchema, FieldRecord } from '@/lib/field-render';
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

type LeadContatoVinculo = {
  contact_id: string;
  is_principal: boolean;
  contact: FieldRecord & {
    id: string;
    nome: string;
    company?: (FieldRecord & { id: string; nome: string }) | null;
  };
};

type LeadCompleto = FieldRecord & {
  id: string;
  responsavel?: { id: string; nome: string } | null;
  lead_contacts?: LeadContatoVinculo[];
};

/**
 * Vista rápida do lead dentro do chat. Passou a ser guiada pelo schema de
 * campos: antes mostrava cinco campos fixos e nenhum customizado, então quem
 * criava um campo só o via no Kanban. Segue somente leitura de propósito — a
 * edição mora no painel do Kanban, e duplicá-la aqui significaria duas cópias
 * da lógica de save.
 */
export function LeadDetailsSheet({ lead, open, onOpenChange }: LeadDetailsSheetProps) {
  // Mesma queryKey do drawer do Kanban: os dois compartilham cache.
  const { data: completo, isLoading } = useQuery<LeadCompleto>({
    queryKey: ['lead', lead?.id],
    queryFn: async () => (await api.get(`/api/leads/${lead?.id}`)).data,
    enabled: !!lead?.id && open,
  });

  const { data: schema } = useQuery<FieldSchema>({
    queryKey: ['custom-fields-schema'],
    queryFn: async () => (await api.get('/api/custom-fields/schema')).data,
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const vinculos = completo?.lead_contacts ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Detalhes do lead</SheetTitle>
          <SheetDescription>Informações do contato e do funil.</SheetDescription>
        </SheetHeader>

        {lead && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <Avatar className="h-20 w-20">
                <AvatarFallback className="bg-primary/15 text-xl font-semibold text-primary">
                  {getInitials(lead.nome)}
                </AvatarFallback>
              </Avatar>
              <div>
                <h3 className="text-lg font-semibold">{lead.nome}</h3>
                <p className="text-sm text-muted-foreground">{formatPhone(lead.telefone)}</p>
              </div>
              <Badge variant="secondary">
                {TEMP_LABEL[lead.temperatura] ?? lead.temperatura}
              </Badge>
            </div>

            <Separator />

            {isLoading || !schema ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <>
                <FieldGroupView schema={schema} escopo="LEAD" registro={completo} />

                {completo?.responsavel?.nome && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Responsável
                    </p>
                    <p className="text-sm text-foreground">{completo.responsavel.nome}</p>
                  </div>
                )}

                {vinculos.map((v) => (
                  <div key={v.contact_id} className="space-y-4 rounded-md border p-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <UserRound className="h-3.5 w-3.5" />
                      {v.contact.nome}
                    </p>
                    <FieldGroupView schema={schema} escopo="CONTATO" registro={v.contact} />
                    {v.contact.company && (
                      <div className="space-y-3 border-t pt-3">
                        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <Building2 className="h-3.5 w-3.5" />
                          {v.contact.company.nome}
                        </p>
                        <FieldGroupView
                          schema={schema}
                          escopo="EMPRESA"
                          registro={v.contact.company}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
