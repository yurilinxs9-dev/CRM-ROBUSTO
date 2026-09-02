/**
 * Regras puras do campo editavel no lugar (InlineField): normalizacao do
 * rascunho, decisao de commit (salvar / ignorar) e formatacao de leitura.
 */
export type Variante = 'text' | 'phone' | 'email' | 'currency' | 'select';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "1.500" e "1.500.000" sao milhar em pt-BR; "1.5" e "1234.56" sao decimal.
const MILHAR_COM_PONTO = /^-?\d{1,3}(\.\d{3})+$/;

/** Mesma regra do formatPhone do card de lead (a lib nao importa de components). */
function mascararTelefone(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length === 13 && digitos.startsWith('55')) {
    return `+55 (${digitos.slice(2, 4)}) ${digitos.slice(4, 9)}-${digitos.slice(9)}`;
  }
  if (digitos.length === 11) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
  }
  return valor;
}

/** Normaliza o rascunho antes de comparar/salvar; null = campo limpo. */
export function normalizar(variante: Variante, rascunho: string): string | null {
  const t = rascunho.trim();
  if (t === '') return null;
  switch (variante) {
    case 'phone': {
      const d = t.replace(/\D/g, '');
      return d === '' ? null : d;
    }
    case 'email':
      return t.toLowerCase();
    case 'currency': {
      const limpo = t.replace(/[^\d.,-]/g, '');
      if (limpo === '') return null;
      // "1.234,56" -> "1234.56"; "1.500" -> "1500"; "1234.56" e "1.5" ficam.
      let semMilhar: string;
      if (limpo.includes(',')) {
        semMilhar = limpo.replace(/\./g, '').replace(',', '.');
      } else if (MILHAR_COM_PONTO.test(limpo)) {
        semMilhar = limpo.replace(/\./g, '');
      } else {
        semMilhar = limpo;
      }
      const n = Number(semMilhar);
      return Number.isFinite(n) ? String(n) : null;
    }
    default:
      return t;
  }
}

/** 'salvar' | 'ignorar' (igual ao atual ou invalido). */
export function decidirCommit(
  variante: Variante,
  atual: string | null,
  rascunho: string,
): { acao: 'salvar'; valor: string | null } | { acao: 'ignorar'; motivo: 'igual' | 'invalido' } {
  const valor = normalizar(variante, rascunho);
  const rascunhoVazio = rascunho.trim() === '';
  if (valor === null && !rascunhoVazio && (variante === 'currency' || variante === 'phone')) {
    return { acao: 'ignorar', motivo: 'invalido' };
  }
  if (variante === 'email' && valor !== null && !EMAIL.test(valor)) {
    return { acao: 'ignorar', motivo: 'invalido' };
  }
  const atualNorm = atual === null || atual === undefined ? null : normalizar(variante, atual);
  if (valor === atualNorm) return { acao: 'ignorar', motivo: 'igual' };
  return { acao: 'salvar', valor };
}

/** Texto mostrado em modo leitura; '' quando o campo esta vazio. */
export function formatarExibicao(
  variante: Variante,
  valor: string | null,
  opcoes: { value: string; label: string }[] = [],
): string {
  if (valor === null || valor === undefined || valor === '') return '';
  if (variante === 'currency') {
    const n = Number(valor);
    return Number.isFinite(n)
      ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : valor;
  }
  if (variante === 'phone') return mascararTelefone(valor);
  if (variante === 'select') return opcoes.find((o) => o.value === valor)?.label ?? valor;
  return valor;
}
