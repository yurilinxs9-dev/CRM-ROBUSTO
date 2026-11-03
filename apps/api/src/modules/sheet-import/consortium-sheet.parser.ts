import { isTestRow, normalizePhone, type MapResult } from './sheet-import.parser';
import type { ImportFieldSpec } from './sheet-import.fields';

const QUESTIONS = [
  ['o_que_você_quer_conquistar?', 'pl_objetivo', 'Objetivo do consórcio'],
  ['qual_o_valor_do_imóvel_que_você_procura?', 'pl_faixa_imovel', 'Faixa de crédito — imóvel'],
  ['qual_o_valor_do_veículo_que_você_procura?', 'pl_faixa_veiculo', 'Faixa de crédito — veículo'],
  ['qual_o_valor_da_carta_que_procura?', 'pl_faixa_carta', 'Faixa de crédito — carta'],
  ['quando_pretende_contratar?', 'pl_prazo', 'Quando pretende contratar'],
  ['qual_parcela_cabe_no_seu_bolso?', 'pl_parcela', 'Parcela desejada'],
  ['você_tem_valor_para_dar_de_lance?', 'pl_lance', 'Disponibilidade de lance'],
] as const;

export const CONSORTIUM_FIELDS: ReadonlyArray<ImportFieldSpec> = [
  ...QUESTIONS.map(([, key, nome], ordem) => ({ key, nome, ordem, tipo: 'text' as const })),
  { key: 'pl_cidade', nome: 'Cidade informada', tipo: 'text', ordem: 7 },
  { key: 'pl_form_data', nome: 'Data do formulário', tipo: 'date', ordem: 8 },
];

function readable(value: string): string {
  const s = value.trim().replace(/_/g, ' ').replace(/r\$/gi, 'R$');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function mapConsortiumRow(row: Record<string, string>): MapResult {
  if (!row.id?.trim()) return { ok: false, motivo: 'linha sem id' };
  if (isTestRow(row) || row.email?.trim().toLowerCase() === 'test@meta.com') return { ok: false, motivo: 'linha de teste do Meta' };
  const telefone = normalizePhone(row.telefone ?? '');
  if (!telefone) return { ok: false, motivo: 'telefone inválido' };
  const dadosCustom: Record<string, string> = {};
  const parts: string[] = [];
  for (const [header, key, label] of QUESTIONS) {
    const value = readable(row[header] ?? '');
    if (value) { dadosCustom[key] = value; parts.push(`${label}: ${value}`); }
  }
  // "Veículo" does not establish car/new/used. Both/undecided stay verbatim.
  if (dadosCustom.pl_objetivo === 'Imóvel') dadosCustom.bem_de_interesse = 'Imóvel';
  if (row.cidade?.trim()) dadosCustom.pl_cidade = row.cidade.trim();
  const ms = Date.parse(row.created_time ?? '');
  if (Number.isFinite(ms)) dadosCustom.pl_form_data = new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
  const attribution: Record<string, string> = {
    utm_source: row.platform?.trim().toLowerCase() || 'meta',
    utm_medium: row.is_organic?.trim().toLowerCase() === 'true' ? 'organic' : 'paid',
  };
  for (const [column, key] of [['campaign_id', 'campaignid'], ['adset_id', 'adgroupid'], ['ad_id', 'creative']]) {
    if (row[column]?.trim()) attribution[key] = row[column].trim().replace(/^[a-z]+:/, '');
  }
  if (row.campaign_name?.trim()) attribution.utm_campaign = row.campaign_name.trim();
  for (const [column, label] of [['campaign_name', 'Campanha'], ['adset_name', 'Conjunto'], ['ad_name', 'Anúncio']]) {
    if (row[column]?.trim()) parts.push(`${label}: ${row[column].trim()}`);
  }
  return { ok: true, lead: {
    sourceRowId: row.id.trim(), nome: row.nome_completo?.trim() || telefone, telefone,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email?.trim() ?? '') ? row.email.trim() : null,
    companyType: 'NAO_INFORMADO', dadosCustom, tags: ['Formulário Consórcio'], attribution,
    atividadeTexto: parts.join(' · '),
  } };
}

interface MatchCandidate { id: string; telefone: string; email: string | null; pipeline_id: string }
const withoutNinth = (phone: string) => phone.length === 13 && phone.startsWith('55') && phone[4] === '9' ? phone.slice(0, 4) + phone.slice(5) : phone;

/** Never steal a partner lead or guess between two sellers' records. */
export function resolveConsortiumMatch<T extends MatchCandidate>(leads: T[], phone: string, email: string | null, pipeline: string): T | null {
  const matches = leads.filter(l => {
    const p = normalizePhone(l.telefone);
    return p === phone || (p && withoutNinth(p) === withoutNinth(phone)) ||
      (email && l.email?.trim().toLowerCase() === email.trim().toLowerCase());
  });
  if (!matches.length) return null;
  const exact = matches.filter(l => normalizePhone(l.telefone) === phone);
  if (matches.length !== 1 || exact.length !== 1 || exact[0].pipeline_id !== pipeline) {
    throw new Error('Possível cadastro existente: revisão manual necessária; nenhum lead foi criado ou transferido');
  }
  return exact[0];
}
