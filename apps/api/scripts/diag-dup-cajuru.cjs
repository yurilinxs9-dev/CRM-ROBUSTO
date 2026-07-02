// Diagnóstico: duplicatas de leads na Cajuru Interiores (pós-fix lead_scope 30/jun).
// Agrupa por chave normalizada (país+DDD+últimos 8 dígitos) pra pegar variantes
// com/sem 9º dígito, e reporta também números suspeitos de LID (@lid → 14+ dígitos).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function normKey(tel) {
  const d = (tel || '').replace(/\D/g, '');
  // BR: 55 + DDD(2) + 8/9 dígitos → ignora 9º dígito
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    return '55' + d.slice(2, 4) + d.slice(-8);
  }
  return d;
}

(async () => {
  const tenant = await prisma.tenant.findFirst({
    where: { nome: { contains: 'ajuru', mode: 'insensitive' } },
    select: { id: true, nome: true },
  });
  if (!tenant) { console.log('tenant Cajuru não encontrado'); process.exit(1); }
  console.log(`tenant: ${tenant.nome} (${tenant.id})\n`);

  const leads = await prisma.lead.findMany({
    where: { tenant_id: tenant.id },
    select: {
      id: true, nome: true, telefone: true, pipeline_id: true, lead_scope: true,
      origem: true, created_at: true, instancia_whatsapp: true, responsavel_id: true,
      _count: { select: { messages: true } },
    },
    orderBy: { created_at: 'asc' },
  });
  console.log(`total leads: ${leads.length}`);

  // 1) duplicatas exatas (mesmo telefone) — não deviam existir dentro do mesmo pipeline
  const byExact = new Map();
  for (const l of leads) {
    const k = l.telefone + '|' + l.pipeline_id;
    (byExact.get(k) || byExact.set(k, []).get(k)).push(l);
  }
  const exactDups = [...byExact.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n== dups EXATAS (mesmo telefone+pipeline): ${exactDups.length} grupos`);
  for (const [k, v] of exactDups.slice(0, 15)) {
    console.log(`  ${k}`);
    for (const l of v) console.log(`    ${l.id} scope=${l.lead_scope === tenant.id ? 'TENANT' : l.lead_scope} origem=${l.origem} msgs=${l._count.messages} created=${l.created_at.toISOString()} nome="${l.nome}"`);
  }

  // 2) mesmo telefone, pipelines diferentes
  const byPhone = new Map();
  for (const l of leads) {
    (byPhone.get(l.telefone) || byPhone.set(l.telefone, []).get(l.telefone)).push(l);
  }
  const crossPipe = [...byPhone.entries()].filter(([, v]) => v.length > 1 && new Set(v.map(x => x.pipeline_id)).size > 1);
  console.log(`\n== mesmo telefone em PIPELINES diferentes: ${crossPipe.length} grupos`);
  for (const [k, v] of crossPipe.slice(0, 10)) {
    console.log(`  tel=${k}: pipelines=${[...new Set(v.map(x => x.pipeline_id))].join(', ')}`);
  }

  // 3) variantes 9º dígito (chave normalizada igual, telefone diferente)
  const byNorm = new Map();
  for (const l of leads) {
    const k = normKey(l.telefone);
    (byNorm.get(k) || byNorm.set(k, []).get(k)).push(l);
  }
  const ninth = [...byNorm.entries()].filter(([, v]) => new Set(v.map(x => x.telefone)).size > 1);
  console.log(`\n== variantes de telefone (9º dígito etc.): ${ninth.length} grupos`);
  for (const [k, v] of ninth.slice(0, 15)) {
    console.log(`  norm=${k}`);
    for (const l of v) console.log(`    tel=${l.telefone} ${l.id} origem=${l.origem} msgs=${l._count.messages} created=${l.created_at.toISOString()} nome="${l.nome}"`);
  }

  // 4) telefones suspeitos de LID (comprimento anômalo pra BR)
  const weird = leads.filter(l => {
    const d = l.telefone.replace(/\D/g, '');
    return d.length >= 14 || (d.startsWith('55') && d.length < 12) === false && !d.startsWith('55');
  });
  const lidLike = leads.filter(l => l.telefone.replace(/\D/g, '').length >= 14);
  console.log(`\n== telefones LID-like (>=14 dígitos): ${lidLike.length}`);
  for (const l of lidLike.slice(0, 15)) {
    console.log(`  tel=${l.telefone} ${l.id} origem=${l.origem} msgs=${l._count.messages} created=${l.created_at.toISOString()} nome="${l.nome}"`);
  }

  // 5) dups por NOME igual (o que o usuário vê como "duplicado")
  const byName = new Map();
  for (const l of leads) {
    const k = (l.nome || '').trim().toLowerCase();
    if (!k || /^\d+$/.test(k)) continue;
    (byName.get(k) || byName.set(k, []).get(k)).push(l);
  }
  const nameDups = [...byName.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n== mesmo NOME, leads distintos: ${nameDups.length} grupos (top 15 recentes)`);
  const sorted = nameDups.sort((a, b) => Math.max(...b[1].map(x => +x.created_at)) - Math.max(...a[1].map(x => +x.created_at)));
  for (const [k, v] of sorted.slice(0, 15)) {
    console.log(`  nome="${k}" (${v.length})`);
    for (const l of v) console.log(`    tel=${l.telefone} ${l.id} pipe=${l.pipeline_id.slice(0, 8)} origem=${l.origem} msgs=${l._count.messages} created=${l.created_at.toISOString()}`);
  }

  await prisma.$disconnect();
})();
