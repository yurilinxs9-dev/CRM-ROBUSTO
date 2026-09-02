/**
 * @mencoes em notas internas. Antes vivia dentro da pagina do chat; a ficha
 * do lead tambem escreve nota, entao a regra mora aqui e as duas telas usam.
 */
export interface MencionavelUser {
  id: string;
  nome: string;
}

/** Minusculas, sem acento — comparacao de mencao. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Casa `@primeironome` ou `@nome completo` (case/acento-insensitive). */
export function extractMentionIds(content: string, users: MencionavelUser[]): string[] {
  const normalized = normalizeName(content);
  const ids: string[] = [];
  for (const u of users) {
    const full = normalizeName(u.nome);
    const first = full.split(/\s+/)[0];
    if (normalized.includes(`@${full}`) || normalized.includes(`@${first}`)) {
      ids.push(u.id);
    }
  }
  return ids;
}

/** `@termo` ainda em edicao no fim do texto ate o cursor. */
const EM_EDICAO = /@([^\s@]*)$/;

/** Sugestoes para o autocomplete: quem comeca com o trecho apos o ultimo '@'. */
export function sugerirMencoes(
  textoAteCursor: string,
  users: MencionavelUser[],
): { termo: string; sugestoes: MencionavelUser[] } | null {
  const m = EM_EDICAO.exec(textoAteCursor);
  if (!m) return null;
  const termo = normalizeName(m[1]);
  const sugestoes = users.filter((u) => normalizeName(u.nome).startsWith(termo));
  return { termo, sugestoes };
}

/** Substitui o `@termo` em edicao pelo `@Nome Completo ` e devolve o cursor. */
export function aplicarMencao(
  textoAteCursor: string,
  resto: string,
  user: MencionavelUser,
): { texto: string; cursor: number } {
  const antes = textoAteCursor.replace(EM_EDICAO, '');
  const inserido = `${antes}@${user.nome} `;
  return { texto: `${inserido}${resto}`, cursor: inserido.length };
}
