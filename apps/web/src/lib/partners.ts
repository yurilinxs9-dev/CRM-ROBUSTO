export const PARTNERS_TENANT = 'a44772ed-1382-4400-84fc-3fa350e23e42';
export const canAccessPartners = (tenant?: string) => tenant === PARTNERS_TENANT;
export const brl = (value: string | number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value));
export function parsePartnerAmount(value: string): string {
  const clean = value.trim().replace(/^R\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(clean)) throw new Error('Informe um valor como 1.234,56, com até duas casas decimais.');
  const [whole, fraction = ''] = clean.replace(/\./g, '').split(',');
  const normalized = `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
  if (Number(normalized) > 999999999999.99) throw new Error('Valor acima do limite permitido.');
  return normalized;
}
export const amountInput = (value: string) => value.replace('.', ',');
export function saoPauloDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export interface Partner { id: string; name: string; contact: string | null; phone: string | null; notes: string | null; joined_on: string; active: boolean; owner_id: string | null; owner_name: string | null; lead_id: string | null; version: number; monthly_total: string }
export interface Production { id: string; partner_id: string; date: string; amount: string; note: string | null; version: number; updated_at: string; updated_by_name: string }
export interface PartnerDashboard {
  month: string; today: string; partners: Partner[]; entries: Production[];
  goal: { amount: string; version: number } | null;
  summary: { total: string; today_total: string; target: string | null; remaining: string | null; excess: string; percentage: number | null; days_remaining: number; required_per_day: string | null; active_partners: number; producing_partners: number };
  daily: { date: string; total: string; accumulated: string }[];
  ranking: { id: string; name: string; total: string }[];
  members: { id: string; name: string }[];
}
export interface PartnerCandidate { id: string; name: string; company: string | null; phone: string }
export interface PartnerAudit { id: string; action: string; entity_id: string; actor_name: string; created_at: string; before: unknown; after: unknown }
