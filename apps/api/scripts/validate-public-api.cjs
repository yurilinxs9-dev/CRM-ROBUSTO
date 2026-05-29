require('dotenv').config();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Uso: node scripts/validate-public-api.cjs <token>'); process.exit(1); }
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const ok = (m) => console.log('  PASS', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

(async () => {
  // 1. verify() auth path
  const key = await p.apiKey.findFirst({ where: { key_hash: sha(TOKEN), active: true }, select: { id: true, tenant_id: true, scopes: true } });
  if (!key) return fail('verify: key nao encontrada');
  ok('verify: tenant=' + key.tenant_id + ' scopes=' + key.scopes.join(','));
  const T = key.tenant_id;
  const bad = await p.apiKey.findFirst({ where: { key_hash: sha('crmk_wrong'), active: true } });
  bad ? fail('verify: token errado aceito') : ok('verify: token invalido rejeitado');

  // 2. listContacts query
  const CONTACT_SELECT = { id: true, nome: true, email: true, telefone: true, tags: true, atendimento_status: true, created_at: true };
  const [total, leads] = await p.$transaction([
    p.lead.count({ where: { tenant_id: T } }),
    p.lead.findMany({ where: { tenant_id: T }, orderBy: { ultima_interacao: 'desc' }, take: 50, skip: 0, select: CONTACT_SELECT }),
  ]);
  leads.length > 0 ? ok('listContacts: total=' + total + ' retornou ' + leads.length + ' status=' + leads[0].atendimento_status) : fail('listContacts: vazio');
  if (leads.length === 0) { await p.$disconnect(); return; }
  const leadId = leads[0].id;

  // 3. getContact
  const one = await p.lead.findFirst({ where: { id: leadId, tenant_id: T }, select: CONTACT_SELECT });
  one ? ok('getContact: ' + one.nome + ' phone=' + one.telefone) : fail('getContact');

  // 4. updateStatus RESOLVED -> revert OPEN
  await p.lead.update({ where: { id: leadId }, data: { atendimento_status: 'RESOLVED' } });
  const chk = await p.lead.findUnique({ where: { id: leadId }, select: { atendimento_status: true } });
  chk.atendimento_status === 'RESOLVED' ? ok('updateStatus: gravou RESOLVED') : fail('updateStatus');
  await p.lead.update({ where: { id: leadId }, data: { atendimento_status: 'OPEN' } });
  ok('updateStatus: revert OPEN');

  // 5. addTags upsert + leadTag + cleanup
  const tag = await p.tag.upsert({ where: { tenant_id_nome: { tenant_id: T, nome: '__e2e_test__' } }, update: {}, create: { nome: '__e2e_test__', tenant_id: T }, select: { id: true } });
  await p.leadTag.createMany({ data: [{ lead_id: leadId, tag_id: tag.id, tenant_id: T }], skipDuplicates: true });
  const lt = await p.leadTag.findFirst({ where: { lead_id: leadId, tag_id: tag.id } });
  lt ? ok('addTags: leadTag criada (upsert+createMany ok)') : fail('addTags: leadTag');
  await p.leadTag.deleteMany({ where: { lead_id: leadId, tag_id: tag.id } });
  await p.tag.delete({ where: { id: tag.id } });
  ok('cleanup: tag de teste removida');

  console.log('\nE2E (DB layer) OK.');
  await p.$disconnect();
})().catch(async (e) => { console.error('ERRO', e.message); await p.$disconnect(); process.exit(1); });
