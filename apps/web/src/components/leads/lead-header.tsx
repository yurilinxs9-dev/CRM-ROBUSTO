'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuthStore, useIsKanbanIndividual, useIsPoolEnabled } from '@/stores/auth.store';
import { formatPhone } from '@/components/kanban/lead-card';
import { TagPicker } from '@/components/kanban/tag-picker';
import { InlineField } from './inline-field';
import { GESTORES, TEMP_OPCOES, tagsParaEditar, type LeadDetail } from './lead-detail-types';

interface Stage {
  id: string;
  nome: string;
  ordem: number;
}
interface Pipeline {
  id: string;
  nome: string;
  stages: Stage[];
}
interface TenantUser {
  id: string;
  nome: string;
}

export interface LeadHeaderProps {
  lead: LeadDetail;
  editavel: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onStage: (estagioId: string) => Promise<void>;
  onClaim: () => Promise<void>;
  onReassign: (userId: string) => Promise<void>;
  onReturnToPool: () => Promise<void>;
}

function iniciais(nome: string): string {
  return nome
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/**
 * Identidade do lead + os campos que mudam de status (temperatura, etapa,
 * responsavel) + as acoes de posse. Tudo some do modo de edicao com
 * `editavel=false` (VISUALIZADOR).
 */
export function LeadHeader({
  lead,
  editavel,
  onPatch,
  onStage,
  onClaim,
  onReassign,
  onReturnToPool,
}: LeadHeaderProps) {
  const me = useAuthStore((s) => s.user);
  const gestor = !!me?.role && GESTORES.includes(me.role);
  const kanbanIndividual = useIsKanbanIndividual();
  const pool = useIsPoolEnabled();
  // No kanban individual as etapas sao as do DONO do lead; gestor pede o board
  // dele com view_as_user_id (mesma regra do kanban). Operador so ve o proprio.
  const pipelineParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (kanbanIndividual && gestor && lead.responsavel_id && lead.responsavel_id !== me?.id) {
      p.view_as_user_id = lead.responsavel_id;
    }
    return p;
  }, [kanbanIndividual, gestor, lead.responsavel_id, me?.id]);

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines', pipelineParams],
    queryFn: async () => (await api.get<Pipeline[]>('/api/pipelines', { params: pipelineParams })).data,
    staleTime: 5 * 60_000,
  });
  const { data: users = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => (await api.get<TenantUser[]>('/api/users/list')).data,
    enabled: gestor,
  });

  const pipeline = pipelines.find((p) => p.id === lead.pipeline_id) ?? pipelines[0];
  const etapas = [...(pipeline?.stages ?? [])].sort((a, b) => a.ordem - b.ordem);
  const naNuvem = !lead.responsavel && !!lead.returned_at;
  const semDono = !lead.responsavel_id;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar className="h-14 w-14 shrink-0">
          {lead.foto_url && <AvatarImage src={lead.foto_url} alt="" />}
          <AvatarFallback className="text-base font-semibold">{iniciais(lead.nome)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          {/* O rotulo "Nome" fica so para leitor de tela: o nome do lead ja e o
              titulo visual da ficha. */}
          <InlineField
            label="Nome"
            variante="text"
            value={lead.nome}
            disabled={!editavel}
            onSave={(v) => onPatch({ nome: v ?? '' })}
            className="[&>p:first-child]:sr-only"
          />
          <p className="px-2 text-xs text-muted-foreground">{formatPhone(lead.telefone)}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={`/chat/${lead.id}`}>
            <MessageCircle className="mr-1.5 h-4 w-4" />
            Abrir chat
          </Link>
        </Button>
      </div>

      {(naNuvem || lead.is_private) && (
        <div className="flex flex-wrap gap-2">
          {naNuvem && (
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
              Disponível
            </Badge>
          )}
          {lead.is_private && <Badge variant="outline">Privado</Badge>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <InlineField
          label="Temperatura"
          variante="select"
          value={lead.temperatura}
          opcoes={TEMP_OPCOES}
          disabled={!editavel}
          onSave={(v) => onPatch({ temperatura: v })}
        />
        <InlineField
          label="Etapa"
          variante="select"
          value={lead.estagio_id}
          opcoes={etapas.map((e) => ({ value: e.id, label: e.nome }))}
          disabled={!editavel || etapas.length === 0}
          onSave={(v) => (v ? onStage(v) : Promise.resolve())}
        />
        <InlineField
          label="Responsável"
          variante="select"
          value={lead.responsavel_id}
          opcoes={users.map((u) => ({ value: u.id, label: u.nome }))}
          placeholder={semDono ? 'Sem responsável' : undefined}
          disabled={!editavel || !gestor}
          onSave={(v) => (v ? onReassign(v) : Promise.resolve())}
        />
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Instância
          </p>
          <p className="px-2 py-1 text-sm">{lead.instancia_whatsapp ?? '—'}</p>
        </div>
      </div>

      {/* Lead na nuvem qualquer um assume; lead sem dono so quando o tenant tem
          o pool ligado — sem pool, "sem responsavel" nao e um lead disponivel. */}
      {editavel && (naNuvem || (semDono && pool)) && (
        <Button size="sm" className="w-full" onClick={() => void onClaim()}>
          ✋ Assumir lead
        </Button>
      )}
      {editavel && gestor && lead.responsavel_id && (
        <Button size="sm" variant="outline" className="w-full" onClick={() => void onReturnToPool()}>
          Devolver ao escritório
        </Button>
      )}

      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Tags</p>
        {editavel ? (
          <TagPicker
            value={tagsParaEditar(lead)}
            // O picker nao tem slot de erro: toast. Sem o catch a rejeicao do
            // PATCH vira unhandled rejection.
            onChange={(next) =>
              onPatch({ tags: next }).catch((e: unknown) =>
                toast.error(e instanceof Error ? e.message : 'Não foi possível salvar'),
              )
            }
          />
        ) : (
          <p className="px-2 text-sm">{tagsParaEditar(lead).join(', ') || '—'}</p>
        )}
      </div>
    </div>
  );
}
