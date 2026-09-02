'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Ficha360 } from '@/components/leads/ficha-360';
import { LeadHeader } from '@/components/leads/lead-header';
import { LeadFields } from '@/components/leads/lead-fields';
import { LeadMediaGrid } from '@/components/leads/lead-media-grid';
import { LeadTimeline } from '@/components/leads/lead-timeline';
import {
  lerValorEstimado,
  podeEditar,
  tagsDoLead,
  type LeadDetail,
} from '@/components/leads/lead-detail-types';

function statusDe(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}
function mensagemDe(err: unknown): string | undefined {
  return (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
}

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;
  const queryClient = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const editavel = podeEditar(me?.role);

  const {
    data: lead,
    isLoading,
    error,
  } = useQuery<LeadDetail>({
    queryKey: ['lead', leadId],
    queryFn: async () => (await api.get<LeadDetail>(`/api/leads/${leadId}`)).data,
    enabled: !!leadId,
    // Lead fora do alcance (403) ou inexistente (404) nao melhora com retry.
    retry: (count, err) => ![403, 404].includes(statusDe(err) ?? 0) && count < 2,
  });

  // Se o lead for arquivado enquanto a ficha esta aberta, nao adianta ficar
  // numa tela que o backend ja nao serve — avisa e volta para a lista.
  useEffect(() => {
    if (!leadId) return;
    const socket = getSocket();
    const aoAtualizar = (payload: { leadId?: string; arquivado?: boolean }) => {
      if (payload?.arquivado === true && payload?.leadId === leadId) {
        toast.info('Lead arquivado');
        router.push('/leads');
      }
    };
    socket.on('lead:updated', aoAtualizar);
    return () => {
      socket.off('lead:updated', aoAtualizar);
    };
  }, [leadId, router]);

  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-activities', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
  };

  // Todas as gravacoes rejeitam com Error(message) — e o que o InlineField
  // mostra abaixo do campo. Toast so nas acoes de botao.
  const chamar = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      invalidar();
    } catch (err) {
      throw new Error(mensagemDe(err) ?? 'Não foi possível salvar');
    }
  };
  const onPatch = (body: Record<string, unknown>) =>
    chamar(() => api.patch(`/api/leads/${leadId}`, body));
  const onStage = (estagio_id: string) =>
    chamar(() => api.patch(`/api/leads/${leadId}/stage`, { estagio_id }));
  const onReassign = (novoResponsavelId: string) =>
    chamar(() => api.post(`/api/leads/${leadId}/reassign`, { novoResponsavelId }));
  const claim = useMutation({
    mutationFn: () => chamar(() => api.post(`/api/leads/${leadId}/claim`)),
    onSuccess: () => toast.success('Lead assumido!'),
    onError: (e: Error) => toast.error(e.message),
  });
  const devolver = useMutation({
    mutationFn: () => chamar(() => api.post(`/api/leads/${leadId}/return-to-pool`)),
    onSuccess: () => toast.success('Lead devolvido ao escritório.'),
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 p-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !lead) {
    const status = statusDe(error);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {status === 403 || status === 404
            ? 'Lead não encontrado ou fora do seu alcance.'
            : 'Não foi possível carregar o lead.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => router.push('/leads')}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Voltar para leads
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:overflow-hidden">
        {/* Coluna esquerda: identidade, campos e Ficha 360. Abaixo de lg tudo
            empilha e a rolagem e a da pagina inteira. */}
        <aside className="space-y-5 lg:overflow-y-auto lg:pr-1">
          <LeadHeader
            lead={lead}
            editavel={editavel}
            onPatch={onPatch}
            onStage={onStage}
            onClaim={() => claim.mutateAsync().then(() => undefined)}
            onReassign={onReassign}
            onReturnToPool={() => devolver.mutateAsync().then(() => undefined)}
          />
          <LeadFields lead={lead} editavel={editavel} onPatch={onPatch} />
          <Ficha360
            leadId={lead.id}
            lead={{
              nome: lead.nome,
              telefone: lead.telefone,
              etapa: lead.estagio?.nome ?? '',
              temperatura: lead.temperatura,
              valor_estimado: lerValorEstimado(lead.valor_estimado),
              ultima_interacao: lead.ultima_interacao ?? null,
              responsavel: lead.responsavel?.nome ?? null,
              tags: tagsDoLead(lead),
            }}
            mostrarCabecalho={false}
            colapsavel
            // Lido so na primeira renderizacao, de proposito: no celular a
            // ficha nasce fechada para nao empurrar o formulario da tela.
            abertoInicial={typeof window !== 'undefined' && window.innerWidth >= 1024}
          />
        </aside>

        {/* Coluna direita: timeline do lead e galeria de midia. */}
        <section className="flex min-h-0 flex-col">
          <Tabs defaultValue="atividade" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="shrink-0 self-start">
              <TabsTrigger value="atividade">Atividade</TabsTrigger>
              <TabsTrigger value="midia">Mídia</TabsTrigger>
            </TabsList>
            <TabsContent value="atividade" className="flex min-h-0 flex-1 flex-col">
              <LeadTimeline leadId={lead.id} editavel={editavel} />
            </TabsContent>
            <TabsContent value="midia" className="min-h-0 flex-1 overflow-y-auto">
              <LeadMediaGrid leadId={lead.id} />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
