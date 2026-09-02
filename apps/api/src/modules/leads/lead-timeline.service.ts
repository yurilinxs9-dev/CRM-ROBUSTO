import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadsService } from './leads.service';
import {
  agruparSessoes,
  decodificarCursor,
  mesclarTimeline,
  mesmaSessao,
  SESSAO_MAX_MENSAGENS,
  type AtividadeItem,
  type LembreteItem,
  type MensagemParaSessao,
  type NotaItem,
  type Pessoa,
  type TarefaItem,
  type TimelineCursor,
  type TimelineItem,
} from './lead-timeline';

export const timelineQuerySchema = z.object({
  // Cursor opaco (`quando|id|mensagensAntes`) — quem valida o formato e o
  // decodificarCursor, aqui e so string.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** Lote extra lido para fechar a sessao cortada pela paginacao. */
const LOTE_FECHAMENTO = 50;

interface Fonte {
  items: TimelineItem[];
  temMais: boolean;
}
const VAZIA: Fonte = { items: [], temMais: false };

/**
 * Timeline unica do lead: sessoes de conversa, notas internas, atividades,
 * tarefas e lembretes. Cinco fontes lidas em paralelo, mescladas e cortadas em
 * `limit`. Gate de acesso = `LeadsService.findOne` (mesma regra da ficha);
 * recorte de mensagens = o do chat (`messageScopeFor`).
 *
 * Paginacao (contrato de `lead-timeline.ts`):
 * - fontes por data (notas, atividades, tarefas, lembretes) leem com
 *   `created_at <= cursor.quando` — INCLUSIVO; o desempate por `(quando, id)`
 *   e feito em memoria por `mesclarTimeline`, que recebe o cursor decodificado;
 * - a fonte de mensagens le com `created_at < cursor.mensagensAntes` —
 *   ESTRITO, e so quando o campo existe; `cursor.quando` NAO vale para
 *   mensagens (uma nota no meio de uma sessao ja servida faria a pagina
 *   seguinte reagrupar um pedaco dessa sessao).
 */
@Injectable()
export class LeadTimelineService {
  constructor(
    private prisma: PrismaService,
    private leads: LeadsService,
  ) {}

  async getTimeline(
    leadId: string,
    user: AuthUser,
    q: TimelineQuery,
  ): Promise<{ items: TimelineItem[]; nextCursor?: string }> {
    // Gate primeiro: nada e lido antes de saber que este usuario ve o lead.
    const lead = await this.leads.findOne(leadId, user);

    let cursor: TimelineCursor | undefined;
    if (q.cursor) {
      const decodificado = decodificarCursor(q.cursor);
      if (!decodificado) throw new BadRequestException('cursor invalido');
      cursor = decodificado;
    }
    const ate = cursor ? new Date(cursor.quando) : undefined;
    const mensagensAntes = cursor?.mensagensAntes ? new Date(cursor.mensagensAntes) : undefined;

    const scope = await this.leads.messageScopeFor(
      {
        id: lead.id,
        responsavel_id: lead.responsavel_id,
        instancia_whatsapp: lead.instancia_whatsapp,
        assumed_at: lead.assumed_at ? new Date(lead.assumed_at) : null,
        is_private: lead.is_private,
      },
      user,
    );

    // `scope === null` = nenhuma mensagem visivel; corta sessoes E notas
    // (nota interna tambem e Message e segue o mesmo recorte do chat).
    const fontes = await Promise.all([
      scope === null ? VAZIA : this.sessoes(leadId, user, scope, mensagensAntes, q.limit),
      scope === null ? VAZIA : this.notas(leadId, user, scope, ate, q.limit),
      this.atividades(leadId, user, ate, q.limit),
      this.tarefas(leadId, user, ate, q.limit),
      this.lembretes(leadId, user, ate, q.limit),
    ]);
    return mesclarTimeline(
      fontes.map((f) => f.items),
      q.limit,
      fontes.some((f) => f.temMais),
      cursor,
    );
  }

  /** Fontes por data: recorte INCLUSIVO, o desempate fica com mesclarTimeline. */
  private ateInclusive(ate?: Date): { created_at?: Prisma.DateTimeFilter } {
    return ate ? { created_at: { lte: ate } } : {};
  }

  private baseMensagem(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
  ): Prisma.MessageWhereInput {
    // `messageScopeFor` devolve so o recorte; lead e tenant sao por conta de
    // quem chama (contrato da Task 1).
    return { lead_id: leadId, tenant_id: user.tenantId, ...scope };
  }

  private async sessoes(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
    mensagensAntes: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const select = {
      id: true,
      created_at: true,
      direction: true,
      type: true,
      content: true,
      instance_name: true,
    } as const;
    const where: Prisma.MessageWhereInput = {
      ...this.baseMensagem(leadId, user, scope),
      is_internal_note: false,
      ...(mensagensAntes ? { created_at: { lt: mensagensAntes } } : {}),
    };
    let rows: MensagemParaSessao[] = await this.prisma.message.findMany({
      where,
      select,
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    });
    const temMais = rows.length > limit;
    // Fecha a ultima sessao: enquanto a mensagem seguinte (mais antiga) ainda
    // estiver a menos de 30 min da ultima lida, continua lendo, ate o teto.
    // Sem isso o `mensagensAntes` do proximo cursor cairia no corte do `take`
    // em vez de numa fronteira real de sessao, e a pagina seguinte reabriria
    // um pedaco da sessao ja servida.
    let lidas = 0;
    while (rows.length > 0 && temMais && lidas < SESSAO_MAX_MENSAGENS) {
      const ultima = rows[rows.length - 1];
      // `lte` e nao `lt`: duas mensagens podem cair no MESMO milissegundo, e
      // com `lt` a irma de timestamp identico ao da ultima lida nunca entrava.
      // O preco e reler as empatadas, descartadas aqui pelo Set de ids.
      const jaLidas = new Set(rows.map((m) => m.id));
      const proximas: MensagemParaSessao[] = await this.prisma.message.findMany({
        where: { ...where, created_at: { lte: ultima.created_at } },
        select,
        orderBy: { created_at: 'desc' },
        take: LOTE_FECHAMENTO,
      });
      if (proximas.length === 0) break;
      const novas = proximas.filter((m) => !jaLidas.has(m.id));
      if (novas.length === 0) break;
      const corte = novas.findIndex((m, i) => {
        const anterior = i === 0 ? ultima : novas[i - 1];
        return !mesmaSessao(anterior.created_at, m.created_at);
      });
      const pertencem = corte === -1 ? novas : novas.slice(0, corte);
      if (pertencem.length === 0) break;
      rows = rows.concat(pertencem);
      lidas += pertencem.length;
      if (corte !== -1) break;
    }
    return { items: agruparSessoes(rows), temMais };
  }

  private async notas(
    leadId: string,
    user: AuthUser,
    scope: Prisma.MessageWhereInput,
    ate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.message.findMany({
      where: {
        ...this.baseMensagem(leadId, user, scope),
        is_internal_note: true,
        ...this.ateInclusive(ate),
      },
      select: {
        id: true,
        created_at: true,
        content: true,
        metadata: true,
        sent_by: { select: { id: true, nome: true } },
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    });
    const temMais = rows.length > limit;
    const usadas = temMais ? rows.slice(0, limit) : rows;
    const idsMencionados = new Set<string>();
    for (const r of usadas) for (const id of mentionsDe(r.metadata)) idsMencionados.add(id);
    // Mencao so resolve DENTRO do tenant: id vindo do metadata e dado antigo,
    // nao vira nome de usuario de outra empresa.
    const pessoas: Pessoa[] = idsMencionados.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...idsMencionados] }, tenant_id: user.tenantId },
          select: { id: true, nome: true },
        })
      : [];
    const porId = new Map(pessoas.map((p) => [p.id, p]));
    const items: NotaItem[] = usadas.map((r) => ({
      tipo: 'nota',
      id: r.id,
      quando: r.created_at.toISOString(),
      conteudo: r.content ?? '',
      autor: r.sent_by ?? null,
      mencoes: mentionsDe(r.metadata)
        .map((id) => porId.get(id))
        .filter((p): p is Pessoa => !!p),
    }));
    return { items, temMais };
  }

  private async atividades(
    leadId: string,
    user: AuthUser,
    ate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.leadActivity.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId, ...this.ateInclusive(ate) },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        tipo: true,
        descricao: true,
        dados_antes: true,
        dados_depois: true,
        created_at: true,
        user: { select: { id: true, nome: true } },
      },
    });
    const temMais = rows.length > limit;
    const items: AtividadeItem[] = (temMais ? rows.slice(0, limit) : rows).map((r) => ({
      tipo: 'atividade',
      id: r.id,
      quando: r.created_at.toISOString(),
      subtipo: r.tipo,
      descricao: r.descricao,
      dados_antes: r.dados_antes,
      dados_depois: r.dados_depois,
      autor: r.user ?? null,
    }));
    return { items, temMais };
  }

  private async tarefas(
    leadId: string,
    user: AuthUser,
    ate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    // Tarefa concluida entra DUAS vezes na timeline (criacao e conclusao), e
    // cada evento tem `quando` proprio. Uma leitura so, ordenada por
    // `created_at`, perdia o evento `:concluida` de tarefa antiga fechada
    // ontem: ela cai no fim da ordenacao, o `take` corta, e nas paginas
    // seguintes o cursor ja passou por ela — o evento sumia sem sinal.
    // Por isso sao duas leituras, cada uma ordenada pelo campo do SEU evento.
    const select = {
      id: true,
      titulo: true,
      tipo: true,
      status: true,
      scheduled_at: true,
      completed_at: true,
      created_at: true,
      responsavel: { select: { id: true, nome: true } },
    } as const;
    const doLead = { lead_id: leadId, tenant_id: user.tenantId };
    const [criadas, concluidas] = await Promise.all([
      this.prisma.task.findMany({
        where: { ...doLead, ...this.ateInclusive(ate) },
        orderBy: { created_at: 'desc' },
        take: limit + 1,
        select,
      }),
      this.prisma.task.findMany({
        where: { ...doLead, completed_at: { not: null, ...(ate ? { lte: ate } : {}) } },
        orderBy: { completed_at: 'desc' },
        take: limit + 1,
        select,
      }),
    ]);
    const temMais = criadas.length > limit || concluidas.length > limit;
    const items: TarefaItem[] = [];
    for (const r of criadas.length > limit ? criadas.slice(0, limit) : criadas) {
      items.push({
        tipo: 'tarefa',
        id: `${r.id}:criada`,
        quando: r.created_at.toISOString(),
        evento: 'criada',
        ...camposDaTarefa(r),
      });
    }
    for (const r of concluidas.length > limit ? concluidas.slice(0, limit) : concluidas) {
      // `completed_at: { not: null }` ja garante isto no where; o guard existe
      // so para o tipo (Prisma devolve `Date | null`).
      if (!r.completed_at) continue;
      items.push({
        tipo: 'tarefa',
        id: `${r.id}:concluida`,
        quando: r.completed_at.toISOString(),
        evento: 'concluida',
        ...camposDaTarefa(r),
      });
    }
    return { items, temMais };
  }

  private async lembretes(
    leadId: string,
    user: AuthUser,
    ate: Date | undefined,
    limit: number,
  ): Promise<Fonte> {
    const rows = await this.prisma.leadLembrete.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId, ...this.ateInclusive(ate) },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        motivo: true,
        avisar_em: true,
        status: true,
        origem: true,
        created_at: true,
      },
    });
    const temMais = rows.length > limit;
    const items: LembreteItem[] = (temMais ? rows.slice(0, limit) : rows).map((r) => ({
      tipo: 'lembrete',
      id: r.id,
      quando: r.created_at.toISOString(),
      motivo: r.motivo,
      avisar_em: r.avisar_em.toISOString(),
      status: r.status,
      origem: r.origem,
    }));
    return { items, temMais };
  }
}

/** Campos comuns aos dois eventos (`criada` e `concluida`) da mesma tarefa. */
function camposDaTarefa(r: {
  titulo: string;
  tipo: string;
  status: string;
  scheduled_at: Date;
  completed_at: Date | null;
  responsavel: Pessoa | null;
}): Omit<TarefaItem, 'tipo' | 'id' | 'quando' | 'evento'> {
  return {
    titulo: r.titulo,
    tipo_tarefa: r.tipo,
    status: r.status,
    scheduled_at: r.scheduled_at.toISOString(),
    completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    responsavel: r.responsavel ?? null,
  };
}

/** `metadata.mentions` e gravado por createInternalNote como array de ids. */
function mentionsDe(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = (metadata as { mentions?: unknown }).mentions;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}
