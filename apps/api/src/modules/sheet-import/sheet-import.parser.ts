/**
 * Parser da planilha do Meta Lead Ads (export padrão do Google Sheets).
 *
 * Funções puras: sem Nest, sem Prisma, sem rede. O service só orquestra.
 * Ver docs/superpowers/specs/2026-09-08-importacao-planilha-meta-design.md.
 */

export type CompanyType = 'MEI' | 'ME_LTDA' | 'PESSOA_FISICA' | 'NAO_INFORMADO';

export const COMPANY_TYPE_LABEL: Record<CompanyType, string> = {
  MEI: 'MEI',
  ME_LTDA: 'ME/LTDA',
  PESSOA_FISICA: 'Pessoa Física',
  NAO_INFORMADO: 'Não informado',
};

/** CSV RFC 4180 simples: aspas, vírgula dentro de aspas, aspas duplicadas, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let entreAspas = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (entreAspas) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') {
      entreAspas = true;
    } else if (c === ',') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      linha.push(campo);
      campo = '';
      linhas.push(linha);
      linha = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }

  const [header, ...corpo] = linhas.filter((l) => !(l.length === 1 && l[0] === ''));
  if (!header) return [];
  return corpo.map((valores) => {
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = valores[idx] ?? '';
    });
    return row;
  });
}

/**
 * Só dígitos, com DDI 55 — o mesmo formato que o inbound grava em
 * `Lead.telefone`, senão o dedupe por telefone não encontra o card.
 */
export function normalizePhone(raw: string): string | null {
  const digitos = raw.replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return digitos;
  return null;
}

function semAcento(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * A pergunta "sua empresa é MEI ou LTDA?" é texto livre. A ordem das regras é
 * decisão de produto: quem cita empresa limitada é ME_LTDA mesmo que também
 * fale em MEI ("Mei e LTDA").
 */
export function classifyCompanyType(raw: string): CompanyType {
  const s = semAcento(raw);
  if (s === '') return 'NAO_INFORMADO';
  if (/\bltda\b|limitada|eireli|\bs\/?a\b|\bme\b/.test(s)) return 'ME_LTDA';
  if (/\bmei\b/.test(s)) return 'MEI';
  if (/pessoa f|fisica|nao tenho|autonom|\bcpf\b/.test(s)) return 'PESSOA_FISICA';
  return 'NAO_INFORMADO';
}

const MARCA_TESTE = '<test lead';

/** Linha de teste que o Meta gera ao publicar o formulário. */
export function isTestRow(row: Record<string, string>): boolean {
  if ((row.Email ?? '').trim().toLowerCase() === 'test@meta.com') return true;
  return Object.values(row).some((v) => v.includes(MARCA_TESTE));
}
