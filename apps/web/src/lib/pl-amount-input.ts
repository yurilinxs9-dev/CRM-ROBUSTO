import { brl, parsePartnerAmount } from './partners';

/** Keep reais as reais while typing; a comma explicitly starts the cents. */
export function formatPlAmountInput(value: string, complete = false): string | null {
  const clean = value.replace(/^R\$\s*/, '').replace(/\s/g, '');
  if (!clean) return '';
  if (!/^[\d.]+(?:,\d{0,2})?$/.test(clean)) return null;
  const [whole, fraction] = clean.replace(/\./g, '').split(',');
  if (!whole) return null;
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const formatted = `R$ ${grouped}${fraction === undefined ? '' : `,${fraction}`}`;
  if (!complete) return formatted;
  try { return brl(parsePartnerAmount(fraction === '' ? `${formatted}00` : formatted)); }
  catch { return formatted; }
}

/** Formatting adds separators, so preserve the cursor relative to digits/comma. */
export function plAmountCaret(raw: string, caret: number, formatted: string): number {
  const count = raw.slice(0, caret).replace(/[^\d,]/g, '').length;
  if (!count) return formatted.startsWith('R$ ') ? 3 : 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index++) {
    if (/[\d,]/.test(formatted[index]) && ++seen === count) return index + 1;
  }
  return formatted.length;
}
