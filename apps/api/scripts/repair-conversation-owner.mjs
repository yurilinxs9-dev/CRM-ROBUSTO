/**
 * Repara o invariante "Lead.responsavel_id espelha a conversa ativa".
 *
 * Contexto (Cajuru, 2026-09-03): a migração de Conversation (03/08) deu à
 * conversa do número da loja o dono da instância (admin), enquanto o lead já
 * era do vendedor; a redistribuição manual de 01/09 fez o mesmo. Resultado:
 * lead do vendedor com conversa ativa do admin. Efeitos: o vendedor não via a
 * conversa (corte por conversa) e a PRÓXIMA mensagem do cliente devolvia o
 * lead ao admin (`syncLeadFromActive`) — "o lead sumiu".
 *
 * Direção do reparo: a conversa ativa segue o dono do lead (é o que
 * `transferActiveConversation` faria na hora da atribuição). Só leads COM dono.
 *
 * Por padrão só toca conversa cujo dono atual é gestor (GERENTE/SUPER_ADMIN)
 * ou ninguém — o número da loja. Conversa que hoje é de OUTRO operador (o
 * cliente falou por último no celular dele) fica de fora: trocar o dono ali
 * cegaria esse operador no próprio número. `--all` inclui esses casos.
 *
 * Uso: node scripts/repair-conversation-owner.mjs --tenant <id> [--apply] [--all]
 *      (sem --apply é dry-run)
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const args = process.argv.slice(2);
const tenantId = args[args.indexOf('--tenant') + 1];
const apply = args.includes('--apply');
const all = args.includes('--all');
if (!tenantId || args.indexOf('--tenant') < 0) {
  console.error('uso: --tenant <id> [--apply]');
  process.exit(1);
}

const prisma = new PrismaClient();

// Mesma eleição de `resolveActiveConversation`: maior last_customer_message_at,
// null por último, empate pelo menor id.
const SELECT_MISMATCH = `
  WITH act AS (
    SELECT DISTINCT ON (lead_id) id AS conversation_id, lead_id, responsavel_id, instancia_whatsapp
    FROM "Conversation"
    WHERE tenant_id = $1
    ORDER BY lead_id, last_customer_message_at DESC NULLS LAST, id ASC
  )
  SELECT l.id AS lead_id, l.nome, l.responsavel_id AS lead_resp, a.conversation_id,
         a.responsavel_id AS conv_resp, a.instancia_whatsapp
  FROM "Lead" l JOIN act a ON a.lead_id = l.id
  WHERE l.tenant_id = $1
    AND l.responsavel_id IS NOT NULL
    AND a.responsavel_id IS DISTINCT FROM l.responsavel_id`;

const allRows = await prisma.$queryRawUnsafe(SELECT_MISMATCH, tenantId);
const users = await prisma.user.findMany({ where: { tenant_id: tenantId }, select: { id: true, nome: true, role: true } });
const isManager = (id) => {
  const role = users.find((u) => u.id === id)?.role;
  return role === 'GERENTE' || role === 'SUPER_ADMIN';
};
const rows = all ? allRows : allRows.filter((r) => r.conv_resp === null || isManager(r.conv_resp));
const skipped = allRows.length - rows.length;
const nome = (id) => users.find((u) => u.id === id)?.nome ?? (id ? id.slice(0, 8) : 'null');
const stat = {};
for (const r of rows) {
  const k = `${nome(r.conv_resp)} -> ${nome(r.lead_resp)} (${r.instancia_whatsapp})`;
  stat[k] = (stat[k] ?? 0) + 1;
}
console.log(`tenant ${tenantId}: ${allRows.length} conversas ativas com dono != dono do lead; ${rows.length} elegíveis${all ? '' : ' (dono atual = gestor ou ninguém)'}; ${skipped} de outro operador deixadas de fora`);
console.log(stat);

if (!apply) {
  console.log('dry-run — nada alterado. Rode com --apply para aplicar.');
} else if (rows.length === 0) {
  console.log('nada a aplicar.');
} else {
  // Um UPDATE só (atômico por natureza) em vez de N updates numa transação
  // interativa — pelo pooler, 210 round-trips estouravam o timeout de 5s do
  // Prisma e o script morria com P2028 sem aplicar nada. O guard por
  // `responsavel_id IS NOT DISTINCT FROM <lido>` mantém a proteção contra
  // mudança entre a leitura e a escrita.
  const values = rows
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(', ');
  const params = rows.flatMap((r) => [r.conversation_id, r.conv_resp, r.lead_resp]);
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "Conversation" c SET responsavel_id = v.novo, updated_at = now()
       FROM (VALUES ${values}) AS v(id, atual, novo)
      WHERE c.id = v.id AND c.responsavel_id IS NOT DISTINCT FROM v.atual`,
    ...params,
  );
  console.log(`aplicado: ${result}/${rows.length} conversas atualizadas`);
  const left = await prisma.$queryRawUnsafe(SELECT_MISMATCH, tenantId);
  console.log(`restantes: ${left.length}`);
}
await prisma.$disconnect();
