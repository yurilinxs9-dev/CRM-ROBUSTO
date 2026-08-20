'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  X,
  User,
  Tag,
  Save,
  Activity,
  Loader2,
  Undo2,
  Layers,
  SlidersHorizontal,
  ImageIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { api } from '@/lib/api';
import { useAuthStore, useIsPoolEnabled } from '@/stores/auth.store';
import { TEMP_LABELS, formatPhone, type Temperatura } from './lead-card';
import { ActivityTimeline } from './activity-timeline';
import { FieldGroupList } from '@/components/fields/field-group-list';
import { FieldEditor } from '@/components/fields/field-editor';
import { LeadContactsBlock } from '@/components/fields/lead-contacts-block';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { TagPicker } from './tag-picker';
import { groupFields, flattenFields, initialValues, buildPayload } from '@/lib/field-render';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TenantUser {
  id: string;
  nome: string;
  email: string;
  role: string;
}

interface Tag {
  id: string;
  nome: string;
  cor: string;
}

interface Sector {
  id: string;
  name: string;
  active: boolean;
}

interface LeadContactLink {
  contact_id: string;
  is_principal: boolean;
  contact: {
    id: string;
    nome: string;
    company_id?: string | null;
    company?: { id: string; nome: string } | null;
  };
}

// `type` e não `interface`: só alias de objeto recebe index signature implícita,
// e sem ela o TypeScript recusa passar o lead para readValue/initialValues, que
// aceitam FieldRecord (Record<string, unknown>).
type LeadDetail = {
  id: string;
  nome: string;
  telefone: string;
  email?: string | null;
  temperatura: Temperatura;
  valor_estimado?: string | null;
  foto_url?: string | null;
  responsavel?: { id: string; nome: string; avatar_url?: string | null } | null;
  responsavel_id: string;
  tags?: string[] | null;
  lead_tags?: { tag: Tag }[];
  pipeline_id: string;
  estagio_id: string;
  dados_custom?: Record<string, unknown> | null;
  lead_contacts?: LeadContactLink[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_BADGE: Record<Temperatura, string> = {
  FRIO: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  MORNO: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  QUENTE: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  MUITO_QUENTE: 'bg-red-500/15 text-red-400 border-red-500/30',
};

const TEMP_DOT: Record<Temperatura, string> = {
  FRIO: '#38bdf8',
  MORNO: '#fb923c',
  QUENTE: '#f97316',
  MUITO_QUENTE: '#ef4444',
};

const GESTORES = ['GERENTE', 'SUPER_ADMIN'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LeadDetailDrawerProps {
  leadId: string | null;
  open: boolean;
  onClose: () => void;
  activePipelineId?: string | null;
  /** Sem handler o botão "Arquivar" some — quem abre a ficha fora do Kanban
   *  (o chat) não tem o diálogo de confirmação de arquivamento. */
  onArchive?: (leadId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LeadDetailDrawer({
  leadId,
  open,
  onClose,
  activePipelineId,
  onArchive,
}: LeadDetailDrawerProps) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const isPoolEnabled = useIsPoolEnabled();
  const podeConfigurar = !!currentUser?.role && GESTORES.includes(currentUser.role);

  // Invalidações comuns a toda mutação da ficha. Aberta pelo chat não há
  // pipeline ativo, e ['leads', undefined] não casaria nenhuma listagem — o
  // prefixo cobre os dois casos. ['chat','leads'] é a lista lateral do chat,
  // que mostra responsável e tags e ficava desatualizada após transferir.
  const invalidarListas = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({
      queryKey: activePipelineId ? ['leads', activePipelineId] : ['leads'],
    });
    void queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
  };

  // ---- Remote data ----
  const { data: lead, isLoading: leadLoading } = useQuery<LeadDetail>({
    queryKey: ['lead', leadId],
    queryFn: async () => {
      const res = await api.get(`/api/leads/${leadId}`);
      return res.data as LeadDetail;
    },
    enabled: !!leadId && open,
  });

  const { data: users = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await api.get('/api/users/list');
      return res.data as TenantUser[];
    },
    enabled: open,
    // Always refetch on mount so a member added in TeamTab shows up immediately
    // when the drawer is reopened, instead of being stuck behind a stale cache.
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // Setores ativos do tenant (popular o dropdown "Transferir para setor").
  const { data: sectors = [] } = useQuery<Sector[]>({
    queryKey: ['sectors'],
    queryFn: async () => {
      const res = await api.get('/api/sectors');
      return res.data as Sector[];
    },
    enabled: open,
  });

  // Estrutura de campos do tenant: grupos + definições dos três escopos. É ela
  // que decide o que a ficha desenha — nada de campo hardcoded.
  // Tolera backend antigo: cai para /custom-fields e monta o schema no cliente.
  const { schema, modo, isError: schemaError } = useFieldSchema(open);

  // ---- Form state ----
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [responsavelId, setResponsavelId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  const leadDefs = schema ? flattenFields(groupFields(schema, 'LEAD')) : [];

  // Popula o formulário quando lead e schema chegam.
  useEffect(() => {
    if (!lead || !schema) return;
    setValues(initialValues(flattenFields(groupFields(schema, 'LEAD')), lead));
    // Lead no pool vem com responsavel_id null — o estado do Select é string,
    // e mandar null no PATCH derrubava o save inteiro com "Campos inválidos".
    setResponsavelId(lead.responsavel_id ?? '');
    const existingTags: string[] = lead.tags ?? lead.lead_tags?.map((lt) => lt.tag.nome) ?? [];
    setTags(existingTags);
    setDirty(false);
  }, [lead, schema]);

  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

  const mark = () => setDirty(true);
  const alterarCampo = (key: string, v: unknown) => {
    setValues((p) => ({ ...p, [key]: v }));
    mark();
  };

  // ---- Pool mutations ----
  const claimMutation = useMutation({
    mutationFn: async () => { await api.post(`/api/leads/${leadId}/claim`); },
    onSuccess: () => {
      toast.success('Lead assumido!');
      invalidarListas();
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) toast.error('Lead já foi assumido por outro colega');
      else toast.error('Erro ao assumir lead. Tente novamente.');
    },
  });

  const reassignMutation = useMutation({
    mutationFn: async (novoResponsavelId: string) => {
      await api.post(`/api/leads/${leadId}/reassign`, { novoResponsavelId });
    },
    onSuccess: () => {
      toast.success('Lead transferido.');
      invalidarListas();
    },
    onError: () => toast.error('Erro ao transferir lead.'),
  });

  // Move a conversa para um setor — o backend faz round-robin entre os agentes
  // ativos daquele setor (mesma fila do webhook de entrada).
  const moveToSectorMutation = useMutation({
    mutationFn: async (sectorId: string) => {
      await api.post(`/api/leads/${leadId}/move-to-sector`, { sectorId });
    },
    onSuccess: () => {
      toast.success('Lead transferido para o setor.');
      invalidarListas();
      void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
    },
    onError: () => toast.error('Erro ao transferir lead para o setor.'),
  });

  const returnToPoolMutation = useMutation({
    mutationFn: async () => { await api.post(`/api/leads/${leadId}/return-to-pool`); },
    onSuccess: () => {
      toast.success('Lead devolvido ao escritorio.');
      invalidarListas();
      void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
    },
    onError: () => toast.error('Erro ao devolver lead.'),
  });

  // ---- Save mutation ----
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!leadId) return;
      // buildPayload separa o que vai pra coluna do que vai pro Json e resolve
      // os formatos que o updateLeadSchema exige (ver field-render.spec.ts).
      const { native, custom } = buildPayload(leadDefs, values);
      const body: Record<string, unknown> = {
        ...native,
        // Só vai quando há responsável escolhido: o campo não tem opção
        // "ninguém" (isso é o botão "Devolver ao Escritório"), então vazio
        // aqui significa "não mexe", não "remove o dono".
        ...(responsavelId ? { responsavel_id: responsavelId } : {}),
        tags,
      };
      if (Object.keys(custom).length > 0) body.dados_custom = custom;
      const res = await api.patch(`/api/leads/${leadId}`, body);
      return res.data;
    },
    onSuccess: () => {
      invalidarListas();
      void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
      setDirty(false);
      toast.success('Lead atualizado.');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? 'Erro ao atualizar lead.');
    },
  });

  // Bloco reutilizado: "Transferir para setor" (só aparece se houver setores).
  const sectorSelect = sectors.length > 0 && (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1">
        <Layers className="h-3 w-3" />
        Transferir para setor
      </Label>
      <Select
        disabled={moveToSectorMutation.isPending}
        onValueChange={(v) => moveToSectorMutation.mutate(v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Selecionar setor..." />
        </SelectTrigger>
        <SelectContent>
          {sectors.map((s) => (
            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  // ---- Render ----
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          {leadLoading || !lead ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10 shrink-0">
                <AvatarFallback className="text-sm font-semibold">{getInitials(lead.nome)}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-base truncate">{lead.nome}</SheetTitle>
                <SheetDescription className="text-xs truncate">{formatPhone(lead.telefone)}</SheetDescription>
              </div>
              <Badge variant="outline" className={TEMP_BADGE[lead.temperatura]}>
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: TEMP_DOT[lead.temperatura] }}
                />
                {TEMP_LABELS[lead.temperatura]}
              </Badge>
            </div>
          )}
        </SheetHeader>

        {schemaError ? (
          // Sem isto a ficha ficaria em skeleton para sempre quando o backend
          // está numa versão anterior à do site (rota /schema ainda não existe).
          <div className="flex-1 px-5 py-6">
            <p className="rounded-md border border-destructive/40 px-3 py-4 text-sm text-destructive">
              Não foi possível carregar os campos deste workspace — nem pela rota nova, nem pela
              antiga. Verifique se a API está no ar e recarregue a página.
            </p>
          </div>
        ) : leadLoading || !schema ? (
          <div className="flex-1 space-y-3 px-5 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <Tabs defaultValue="principal" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-5 mt-3 shrink-0 self-start">
              <TabsTrigger value="principal" className="text-xs">Principal</TabsTrigger>
              <TabsTrigger value="estatisticas" className="gap-1 text-xs">
                <Activity className="h-3 w-3" /> Estatísticas
              </TabsTrigger>
              <TabsTrigger value="midia" className="gap-1 text-xs">
                <ImageIcon className="h-3 w-3" /> Mídia
              </TabsTrigger>
              {podeConfigurar && (
                <TabsTrigger value="config" className="gap-1 text-xs">
                  <SlidersHorizontal className="h-3 w-3" /> Configurações
                </TabsTrigger>
              )}
            </TabsList>

            {/* ---------------- Principal ---------------- */}
            <TabsContent
              value="principal"
              className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4"
            >
              <FieldGroupList
                schema={schema}
                escopo="LEAD"
                values={values}
                onChange={alterarCampo}
              />

              {/* Contato/empresa dependem de rotas que o backend antigo não
                  tem — no modo legado o bloco some em vez de dar 404. */}
              {leadId && modo === 'completo' && (
                <LeadContactsBlock
                  leadId={leadId}
                  vinculos={lead?.lead_contacts ?? []}
                  schema={schema}
                />
              )}

              {/* Atribuicao */}
              <section className="space-y-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                  Atribuicao
                </p>
                {isPoolEnabled ? (
                  !lead?.responsavel ? (
                    <div className="space-y-2">
                      <Button
                        className="w-full"
                        disabled={claimMutation.isPending}
                        onClick={() => claimMutation.mutate()}
                      >
                        {claimMutation.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          : <span className="mr-1">✋</span>}
                        {claimMutation.isPending ? 'Assumindo...' : 'Assumir Lead'}
                      </Button>
                      {podeConfigurar && (
                        <div className="space-y-1.5">
                          <Label>Atribuir para</Label>
                          <Select
                            disabled={reassignMutation.isPending}
                            onValueChange={(v) => reassignMutation.mutate(v)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Selecionar operador..." />
                            </SelectTrigger>
                            <SelectContent>
                              {users.map((u) => (
                                <SelectItem key={u.id} value={u.id}>{u.nome}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      {podeConfigurar && sectorSelect}
                    </div>
                  ) : (
                    (() => {
                      const canReassign =
                        currentUser?.id === lead.responsavel.id || podeConfigurar;
                      return (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-[9px]">
                                {getInitials(lead.responsavel.nome)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-sm">{lead.responsavel.nome}</span>
                          </div>
                          {canReassign && (
                            <div className="space-y-1.5">
                              <Label>Transferir para</Label>
                              <Select
                                disabled={reassignMutation.isPending}
                                onValueChange={(v) => reassignMutation.mutate(v)}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Selecionar operador..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {users
                                    .filter((u) => u.id !== lead.responsavel!.id)
                                    .map((u) => (
                                      <SelectItem key={u.id} value={u.id}>{u.nome}</SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          {canReassign && sectorSelect}
                          {canReassign && (
                            <Button
                              variant="outline"
                              className="w-full"
                              disabled={returnToPoolMutation.isPending}
                              onClick={() => returnToPoolMutation.mutate()}
                            >
                              {returnToPoolMutation.isPending
                                ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                : <Undo2 className="h-4 w-4 mr-2" />}
                              {returnToPoolMutation.isPending ? 'Devolvendo...' : 'Devolver ao Escritorio'}
                            </Button>
                          )}
                        </div>
                      );
                    })()
                  )
                ) : (
                  <div className="space-y-1.5">
                    <Label>Responsavel</Label>
                    <Select
                      value={responsavelId}
                      onValueChange={(v) => { setResponsavelId(v); mark(); }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecionar responsavel" />
                      </SelectTrigger>
                      <SelectContent>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.nome}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>
                    <Tag className="inline h-3 w-3 mr-1" />
                    Tags
                  </Label>
                  <TagPicker
                    value={tags}
                    onChange={(next) => { setTags(next); mark(); }}
                  />
                </div>
              </section>
            </TabsContent>

            {/* ---------------- Estatísticas ---------------- */}
            <TabsContent
              value="estatisticas"
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
            >
              {leadId && <ActivityTimeline leadId={leadId} />}
            </TabsContent>

            {/* ---------------- Mídia ---------------- */}
            <TabsContent value="midia" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* Não existe endpoint de listagem de mídias da conversa; inventar
                  um aqui geraria chamada quebrada. Fica explícito até a rota
                  existir. */}
              <p className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
                A galeria de mídias da conversa ainda não está disponível. As imagens, áudios e
                documentos continuam acessíveis dentro do chat.
              </p>
            </TabsContent>

            {/* ---------------- Configurações ---------------- */}
            {podeConfigurar && (
              <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <FieldEditor modo={modo} />
              </TabsContent>
            )}
          </Tabs>
        )}

        {/* Footer actions */}
        {!leadLoading && lead && (
          <div className="px-5 py-4 border-t shrink-0 flex items-center justify-between gap-2">
            {onArchive ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  onArchive(lead.id);
                  onClose();
                }}
              >
                Arquivar
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                <X className="h-3.5 w-3.5 mr-1" />
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                <Save className="h-3.5 w-3.5 mr-1" />
                {saveMutation.isPending ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
