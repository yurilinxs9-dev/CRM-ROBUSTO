'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, User, Tag, DollarSign, Thermometer, Phone, Mail, Save, Activity, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

interface LeadDetail {
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_OPTIONS: Temperatura[] = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'];

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

function formatBRLDisplay(raw: string): string {
  const n = parseFloat(raw.replace(',', '.'));
  if (Number.isNaN(n)) return raw;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LeadDetailDrawerProps {
  leadId: string | null;
  open: boolean;
  onClose: () => void;
  activePipelineId?: string | null;
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
    staleTime: 60_000,
  });

  // ---- Form state ----
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [email, setEmail] = useState('');
  const [temperatura, setTemperatura] = useState<Temperatura>('FRIO');
  const [valorRaw, setValorRaw] = useState('');
  const [responsavelId, setResponsavelId] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [dirty, setDirty] = useState(false);

  // Populate form when lead loads
  useEffect(() => {
    if (!lead) return;
    setNome(lead.nome);
    setTelefone(lead.telefone);
    setEmail(lead.email ?? '');
    setTemperatura(lead.temperatura);
    setValorRaw(lead.valor_estimado ? String(lead.valor_estimado) : '');
    setResponsavelId(lead.responsavel_id);
    const existingTags: string[] = lead.tags ?? lead.lead_tags?.map((lt) => lt.tag.nome) ?? [];
    setTagsInput(existingTags.join(', '));
    setDirty(false);
  }, [lead]);

  // Reset dirty state on close
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

  // Mark dirty on any change
  const mark = () => setDirty(true);

  // ---- Pool mutations ----
  const claimMutation = useMutation({
    mutationFn: async () => { await api.post(`/api/leads/${leadId}/claim`); },
    onSuccess: () => {
      toast.success('Lead assumido!');
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['leads', activePipelineId] });
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
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['leads', activePipelineId] });
    },
    onError: () => toast.error('Erro ao transferir lead.'),
  });

  // ---- Save mutation ----
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!leadId) return;
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        nome,
        telefone,
        temperatura,
        responsavel_id: responsavelId,
        tags,
      };
      if (email.trim()) body.email = email.trim();
      else body.email = null;
      if (valorRaw.trim()) body.valor_estimado = valorRaw.replace(',', '.');
      else body.valor_estimado = null;
      const res = await api.patch(`/api/leads/${leadId}`, body);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['leads', activePipelineId] });
      void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
      setDirty(false);
      toast.success('Lead atualizado.');
    },
    onError: () => {
      toast.error('Erro ao atualizar lead.');
    },
  });

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
                {lead.foto_url ? (
                  <AvatarFallback className="text-sm font-semibold">{getInitials(lead.nome)}</AvatarFallback>
                ) : null}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {leadLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <>
              {/* Informacoes de contato */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  Contato
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-nome">Nome</Label>
                  <Input
                    id="drawer-nome"
                    value={nome}
                    onChange={(e) => { setNome(e.target.value); mark(); }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-telefone">
                    <Phone className="inline h-3 w-3 mr-1" />
                    Telefone
                  </Label>
                  <Input
                    id="drawer-telefone"
                    value={telefone}
                    onChange={(e) => { setTelefone(e.target.value); mark(); }}
                    placeholder="+55 31 99999-9999"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-email">
                    <Mail className="inline h-3 w-3 mr-1" />
                    Email
                    <span className="text-muted-foreground ml-1">(opcional)</span>
                  </Label>
                  <Input
                    id="drawer-email"
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); mark(); }}
                    placeholder="email@exemplo.com"
                  />
                </div>
              </section>

              {/* Qualificacao */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                  <Thermometer className="h-3.5 w-3.5" />
                  Qualificacao
                </p>
                <div className="space-y-1.5">
                  <Label>Temperatura</Label>
                  <Select
                    value={temperatura}
                    onValueChange={(v) => { setTemperatura(v as Temperatura); mark(); }}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: TEMP_DOT[temperatura] }}
                          />
                          {TEMP_LABELS[temperatura]}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {TEMP_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t}>
                          <span className="flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: TEMP_DOT[t] }}
                            />
                            {TEMP_LABELS[t]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-valor">
                    <DollarSign className="inline h-3 w-3 mr-1" />
                    Valor estimado (R$)
                  </Label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                      R$
                    </span>
                    <Input
                      id="drawer-valor"
                      className="pl-8"
                      value={valorRaw}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.,]/g, '');
                        setValorRaw(v);
                        mark();
                      }}
                      placeholder="0,00"
                    />
                  </div>
                  {valorRaw && !Number.isNaN(parseFloat(valorRaw.replace(',', '.'))) && (
                    <p className="text-xs text-muted-foreground">
                      {formatBRLDisplay(valorRaw)}
                    </p>
                  )}
                </div>
              </section>

              {/* Atribuicao */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  Atribuicao
                </p>
                {isPoolEnabled ? (
                  !lead?.responsavel ? (
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
                  ) : (
                    (() => {
                      const canReassign =
                        currentUser?.id === lead.responsavel.id ||
                        currentUser?.role === 'GERENTE' ||
                        currentUser?.role === 'SUPER_ADMIN';
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
                          <SelectItem key={u.id} value={u.id}>
                            {u.nome}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="drawer-tags">
                    <Tag className="inline h-3 w-3 mr-1" />
                    Tags
                    <span className="text-muted-foreground ml-1">(separadas por virgula)</span>
                  </Label>
                  <Input
                    id="drawer-tags"
                    value={tagsInput}
                    onChange={(e) => { setTagsInput(e.target.value); mark(); }}
                    placeholder="vip, retorno, indicacao"
                  />
                  {tagsInput.trim() && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {tagsInput
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                            {tag}
                          </Badge>
                        ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Atividades */}
              {leadId && (
                <section className="space-y-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5" />
                    Atividades
                  </p>
                  <div className="max-h-72 overflow-y-auto pr-1">
                    <ActivityTimeline leadId={leadId} />
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer actions */}
        {!leadLoading && lead && (
          <div className="px-5 py-4 border-t shrink-0 flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                onArchive?.(lead.id);
                onClose();
              }}
            >
              Arquivar
            </Button>
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
