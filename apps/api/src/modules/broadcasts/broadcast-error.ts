/**
 * Motivo da falha do alvo do follow-up, como CÓDIGO.
 *
 * O campo `error` guarda o texto cru da exceção — com url, id e timestamp
 * dentro. Duas quedas da mesma instância viram dois textos diferentes, então
 * "3 falhas" nunca dizia se era instância caída (reconectar) ou cadastro sem
 * telefone (corrigir lead) — decisões opostas. O código é o que permite somar
 * falhas iguais e comparar entre disparos.
 */

export type BroadcastErrorCode =
  | 'sem_telefone'
  | 'fora_da_etapa'
  | 'atendimento_humano'
  | 'mensagem_vazia'
  | 'sem_remetente'
  | 'cliente_ja_conversando'
  | 'instancia_desconectada'
  | 'ia_sem_modelo'
  | 'ia_falhou'
  | 'lead_nao_encontrado'
  | 'sem_permissao'
  | 'provedor_recusou'
  | 'rede'
  | 'outro';

export const BROADCAST_ERROR_LABEL: Record<BroadcastErrorCode, string> = {
  sem_telefone: 'Lead sem telefone',
  fora_da_etapa: 'Lead saiu da etapa alvo',
  atendimento_humano: 'Lead em atendimento humano',
  mensagem_vazia: 'Mensagem ficou vazia',
  sem_remetente: 'Empresa sem admin/gerente ativo para assinar o envio',
  cliente_ja_conversando: 'Cliente já estava conversando',
  instancia_desconectada: 'Instância do WhatsApp desconectada',
  ia_sem_modelo: 'IA sem modelo configurado',
  ia_falhou: 'IA não gerou a mensagem',
  lead_nao_encontrado: 'Lead não encontrado',
  sem_permissao: 'Envio bloqueado por permissão',
  provedor_recusou: 'WhatsApp recusou o envio',
  rede: 'Falha de rede ao enviar',
  outro: 'Outro erro',
};

const MAX_MOTIVO = 120;
const TOP_MOTIVOS = 5;
const BUCKET_RESTO = 'Outros motivos';
const SEM_MOTIVO = 'Motivo não registrado';

/** Classifica a exceção do envio. Nunca lança: erro dentro do erro é ruído. */
export function classifyBroadcastError(err: unknown): BroadcastErrorCode {
  const e = err as { response?: { status?: number }; status?: number; code?: string; message?: string } | undefined;
  const texto = `${e?.message ?? ''} ${String(err ?? '')}`.toLowerCase();

  if (texto.includes('nenhum modelo de ia') || texto.includes('modelo de ia não encontrado')) return 'ia_sem_modelo';
  if (texto.includes('não está conectada') || texto.includes('token uazapi ausente')
    || texto.includes('token evolution ausente') || texto.includes('evolution_base_url')) {
    return 'instancia_desconectada';
  }
  if (texto.includes('lead nao encontrado') || texto.includes('lead não encontrado')) return 'lead_nao_encontrado';
  if (texto.includes('lead privado') || texto.includes('nao pode enviar') || texto.includes('não pode enviar')) {
    return 'sem_permissao';
  }

  const rede = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
  if (typeof e?.code === 'string' && rede.includes(e.code)) return 'rede';

  const status = e?.response?.status ?? (typeof e?.status === 'number' ? e.status : null);
  if (typeof status === 'number' && status >= 400) return 'provedor_recusou';

  return 'outro';
}

export interface FailureRow {
  error_code: string | null;
  error: string | null;
  _count: number;
}

/**
 * Contagem por motivo pronta para o painel. Linhas antigas (gravadas antes do
 * `error_code`) caem no texto livre cortado — jogá-las em "Outros" apagaria a
 * única pista que existe sobre as falhas passadas.
 */
export function aggregateFailureReasons(rows: FailureRow[]): Record<string, number> {
  const porMotivo: Record<string, number> = {};
  for (const r of rows) {
    const rotulo = r.error_code
      ? BROADCAST_ERROR_LABEL[r.error_code as BroadcastErrorCode] ?? r.error_code
      : (r.error?.trim() || SEM_MOTIVO).slice(0, MAX_MOTIVO);
    porMotivo[rotulo] = (porMotivo[rotulo] ?? 0) + r._count;
  }

  const ordenados = Object.entries(porMotivo).sort((a, b) => b[1] - a[1]);
  if (ordenados.length <= TOP_MOTIVOS) return porMotivo;
  const resto = ordenados.slice(TOP_MOTIVOS).reduce((soma, [, n]) => soma + n, 0);
  return { ...Object.fromEntries(ordenados.slice(0, TOP_MOTIVOS)), [BUCKET_RESTO]: resto };
}
