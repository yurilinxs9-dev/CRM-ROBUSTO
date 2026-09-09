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
    .replace(/[\u0300-\u036f]/g, '')
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

export interface ImportedLead {
  sourceRowId: string;
  nome: string;
  telefone: string;
  email: string | null;
  companyType: CompanyType;
  /** Chaves de IMPORT_FIELDS; só as que têm valor. */
  dadosCustom: Record<string, string>;
  tags: string[];
  /** Formato de `attributionInputSchema` (attribution.types.ts). Só chaves com valor. */
  attribution: Record<string, string>;
  atividadeTexto: string;
}

export type MapResult = { ok: true; lead: ImportedLead } | { ok: false; motivo: string };

/** Colunas fixas do export do Meta. As perguntas do formulário ficam entre `platform` e `Email`. */
const COL = {
  id: 'id',
  createdTime: 'created_time',
  adId: 'ad_id',
  adName: 'ad_name',
  adsetId: 'adset_id',
  adsetName: 'adset_name',
  campaignId: 'campaign_id',
  campaignName: 'campaign_name',
  isOrganic: 'is_organic',
  platform: 'platform',
  email: 'Email',
  nome: 'Nome Completo',
  telefone: 'Telefone',
  cidade: 'Cidade',
  estado: 'estado',
} as const;

/** Perguntas conhecidas: header exato → chave do campo custom. Ordem = posição no formulário. */
const PERGUNTAS: ReadonlyArray<{ header: string; key: string; rotulo: string }> = [
  { header: 'há_quantos_anos_na_atua_com_vendas_de_consórcio?', key: 'anos_consorcio', rotulo: 'Anos com consórcio' },
  { header: 'possui_estrutura_física?', key: 'estrutura_fisica', rotulo: 'Estrutura física' },
  { header: 'tem_quantos_vendedores?', key: 'qtd_vendedores', rotulo: 'Quantidade de vendedores' },
  { header: 'média_de_produção_mensal?', key: 'producao_mensal', rotulo: 'Produção mensal' },
  { header: 'sua_empresa_é_mei_ou_ltda?', key: 'tipo_empresa_resposta', rotulo: 'Tipo de empresa' },
];

const EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

function limpo(v: string | undefined): string {
  return (v ?? '').trim();
}

/** Tira o prefixo do Meta (`c:`, `as:`, `ag:`, `l:`), fica só o número. */
function semPrefixo(v: string): string {
  return limpo(v).replace(/^[a-z]+:/, '');
}

/** `created_time` ISO com offset → `AAAA-MM-DD` no fuso de Brasília. */
function dataBrt(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Header em texto legível: tira `_`, `?` e capitaliza nada (fica como pergunta). */
function headerLegivel(h: string): string {
  return h.replace(/_/g, ' ').replace(/\?$/, '').trim();
}

/**
 * Perguntas do formulário: por header exato; se a agência renomeou a pergunta,
 * pela posição relativa entre `platform` e `Email`. Perguntas que não batem
 * com nenhuma conhecida voltam em `extras` (vão só para o texto da atividade).
 */
function respostas(row: Record<string, string>): {
  porKey: Record<string, string>;
  extras: Array<{ rotulo: string; valor: string }>;
} {
  const headers = Object.keys(row);
  const ini = headers.indexOf(COL.platform);
  const fim = headers.indexOf(COL.email);
  const faixa = ini >= 0 && fim > ini ? headers.slice(ini + 1, fim) : [];

  const porKey: Record<string, string> = {};
  const usados = new Set<string>();
  PERGUNTAS.forEach((p, idx) => {
    let header: string | undefined = headers.includes(p.header) ? p.header : undefined;
    if (header === undefined && faixa[idx] !== undefined && !PERGUNTAS.some((q) => q.header === faixa[idx])) {
      header = faixa[idx];
    }
    if (header === undefined) return;
    usados.add(header);
    const v = limpo(row[header]);
    if (v !== '') porKey[p.key] = v;
  });

  const extras = faixa
    .filter((h) => !usados.has(h))
    .map((h) => ({ rotulo: headerLegivel(h), valor: limpo(row[h]) }))
    .filter((e) => e.valor !== '');

  return { porKey, extras };
}

export function mapRow(row: Record<string, string>): MapResult {
  const sourceRowId = limpo(row[COL.id]);
  if (sourceRowId === '') return { ok: false, motivo: 'linha sem id' };
  if (isTestRow(row)) return { ok: false, motivo: 'linha de teste do Meta' };

  const telefoneCru = limpo(row[COL.telefone]);
  const telefone = normalizePhone(telefoneCru);
  if (telefone === null) return { ok: false, motivo: `telefone inválido: ${telefoneCru}` };

  const nome = limpo(row[COL.nome]) || telefone;
  const emailCru = limpo(row[COL.email]);
  const email = EMAIL_SIMPLES.test(emailCru) ? emailCru : null;

  const { porKey, extras } = respostas(row);
  const respostaTipo = porKey.tipo_empresa_resposta ?? '';
  const companyType = classifyCompanyType(respostaTipo);

  const dadosCustom: Record<string, string> = {
    tipo_empresa: COMPANY_TYPE_LABEL[companyType],
    ...porKey,
  };
  const cidade = limpo(row[COL.cidade]);
  const estado = limpo(row[COL.estado]);
  if (cidade !== '') dadosCustom.cidade = cidade;
  if (estado !== '') dadosCustom.estado = estado;
  const formData = dataBrt(limpo(row[COL.createdTime]));
  if (formData !== null) dadosCustom.form_data = formData;

  const tags: string[] = [];
  if (companyType === 'MEI') tags.push('MEI');
  if (companyType === 'PESSOA_FISICA') tags.push('Pessoa Física');

  const organico = limpo(row[COL.isOrganic]).toLowerCase() === 'true';
  const attribution: Record<string, string> = {
    utm_source: limpo(row[COL.platform]).toLowerCase() || 'meta',
    utm_medium: organico ? 'organic' : 'paid',
  };
  const campaignName = limpo(row[COL.campaignName]);
  const campaignId = semPrefixo(row[COL.campaignId] ?? '');
  const adsetId = semPrefixo(row[COL.adsetId] ?? '');
  const adId = semPrefixo(row[COL.adId] ?? '');
  if (campaignName !== '') attribution.utm_campaign = campaignName;
  if (campaignId !== '') attribution.campaignid = campaignId;
  if (adsetId !== '') attribution.adgroupid = adsetId;
  if (adId !== '') attribution.creative = adId;

  const partes: string[] = [];
  partes.push(
    respostaTipo !== ''
      ? `Tipo de empresa: ${COMPANY_TYPE_LABEL[companyType]} (${respostaTipo})`
      : `Tipo de empresa: ${COMPANY_TYPE_LABEL[companyType]}`,
  );
  for (const p of PERGUNTAS) {
    if (p.key === 'tipo_empresa_resposta') continue;
    const v = porKey[p.key];
    if (v !== undefined) partes.push(`${p.rotulo}: ${v}`);
  }
  for (const e of extras) partes.push(`${e.rotulo}: ${e.valor}`);
  if (cidade !== '' || estado !== '') partes.push([cidade, estado].filter((s) => s !== '').join('/'));
  if (campaignName !== '') partes.push(`Campanha: ${campaignName}`);
  const adsetName = limpo(row[COL.adsetName]);
  if (adsetName !== '') partes.push(`Conjunto: ${adsetName}`);
  const adName = limpo(row[COL.adName]);
  if (adName !== '') partes.push(`Anúncio: ${adName}`);

  return {
    ok: true,
    lead: {
      sourceRowId,
      nome,
      telefone,
      email,
      companyType,
      dadosCustom,
      tags,
      attribution,
      atividadeTexto: partes.join(' · '),
    },
  };
}
