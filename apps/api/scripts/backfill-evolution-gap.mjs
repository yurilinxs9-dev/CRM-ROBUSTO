// Recupera as mensagens que o Evolution recebeu mas não conseguiu entregar ao
// CRM entre 14/08/2026 23:50 e 17/08/2026 22:40 (incidente do nginx sem bloco
// 443 — ver commit 8b69306).
//
// RODAR NA VPS:
//   cd /opt/crm-whatsapp/apps/api
//   set -a && . /opt/crm-whatsapp/.env && set +a
//   node scripts/backfill-evolution-gap.mjs            # dry-run (padrão)
//   node scripts/backfill-evolution-gap.mjs --apply    # grava
//
// PRINCÍPIO INEGOCIÁVEL: escreve DIRETO no banco, via Prisma. Não passa pelo
// endpoint de webhook, não enfileira no BullMQ, não chama service nenhum. Pela
// esteira normal, 3 dias de eventos disparariam de uma vez cadências,
// automações de etapa, round-robin, push para operadores, webhooks de saída e
// possivelmente resposta automática de IA para clientes reais. Verificado
// também que não há trigger no banco em Message/Lead/Contact/Conversation.
//
// Idempotente: a unique (tenant_id, whatsapp_message_id) é a rede de proteção,
// usada via createMany({ skipDuplicates: true }). Pode rodar repetido.
//
// TUDO EM LOTE. A primeira versão consultava o banco uma vez por mensagem —
// ~48 mil idas e voltas ao Supabase, inviável. Aqui são algumas dezenas.
//
// FASE 1 (este script): mensagens, leads e metadados de mídia.
// FASE 2 (backfill-evolution-media.mjs): baixa, descriptografa e sobe os
// arquivos — separada porque são ~5,2 mil downloads.
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');

// Janela do apagão, em epoch (segundos). Primeiro 405 no nginx às 15/08 00:05;
// conserto aplicado 17/08 22:40.
const DE = 1786751400; // 2026-08-14 23:50 UTC
const ATE = 1787006400; // 2026-08-17 22:40 UTC

/** Evolution → MessageType do CRM. O que não está aqui é evento de sistema
 *  (protocolMessage, reactionMessage, pollUpdate…), sem representação no
 *  modelo do CRM — pulado de propósito, não é perda de conteúdo. */
const TIPOS = {
  conversation: 'TEXT', extendedTextMessage: 'TEXT', templateMessage: 'TEXT',
  buttonsMessage: 'TEXT', listMessage: 'TEXT', templateButtonReplyMessage: 'TEXT',
  interactiveMessage: 'TEXT',
  imageMessage: 'IMAGE', albumMessage: 'IMAGE',
  audioMessage: 'AUDIO',
  videoMessage: 'VIDEO', ptvMessage: 'VIDEO',
  documentMessage: 'DOCUMENT',
  stickerMessage: 'STICKER',
  locationMessage: 'LOCATION',
  contactMessage: 'CONTACT', contactsArrayMessage: 'CONTACT',
};

const PLACEHOLDER = {
  IMAGE: '[imagem]', AUDIO: '[áudio]', VIDEO: '[vídeo]', DOCUMENT: '[documento]',
  STICKER: '[figurinha]', LOCATION: '[localização]', CONTACT: '[contato]',
};

const prisma = new PrismaClient();
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const log = (...a) => console.log(...a);

/** Telefone a partir do JID — mesma regra do resolveEvolutionPhone do
 *  evolution-events.handler. Grupo e LID sem PN resolvível ficam de fora. */
function telefoneDe(r) {
  const digitos = (jid) =>
    typeof jid === 'string' && jid.includes('@s.whatsapp.net')
      ? jid.split('@')[0].split(':')[0].replace(/\D/g, '') || null
      : null;
  if (!r.jid || r.jid.includes('@g.us')) return null;
  if (!r.jid.endsWith('@lid')) return digitos(r.jid);
  return digitos(r.jid_alt) ?? digitos(r.sender_pn);
}

async function main() {
  log(`Janela: ${new Date(DE * 1000).toISOString()} → ${new Date(ATE * 1000).toISOString()}`);
  log(APPLY ? 'MODO: GRAVANDO\n' : 'MODO: dry-run (nada será gravado)\n');

  // --- instâncias do CRM (o mesmo Evolution atende outro sistema) ---
  const instancias = await prisma.whatsappInstance.findMany({
    select: { nome: true, tenant_id: true, owner_user_id: true },
  });
  const doCrm = new Map(instancias.map((i) => [i.nome, i]));
  const nomes = [...doCrm.keys()].map((n) => `'${n.replace(/'/g, "''")}'`).join(',');

  // --- export do Evolution ---
  const sql = `COPY (
    SELECT json_build_object(
      'wa_id', m."key"->>'id', 'jid', m."key"->>'remoteJid',
      'jid_alt', m."key"->>'remoteJidAlt', 'sender_pn', m."key"->>'senderPn',
      'from_me', COALESCE((m."key"->>'fromMe')::boolean,false),
      'ts', m."messageTimestamp", 'tipo', m."messageType", 'push_name', m."pushName",
      'instancia', i.name,
      'texto', COALESCE(m.message->>'conversation', m.message->'extendedTextMessage'->>'text',
                        m.message->'imageMessage'->>'caption', m.message->'videoMessage'->>'caption',
                        m.message->'documentMessage'->>'caption'),
      'midia', COALESCE(m.message->'imageMessage', m.message->'audioMessage',
                        m.message->'videoMessage', m.message->'documentMessage',
                        m.message->'stickerMessage', m.message->'ptvMessage'))
    FROM "Message" m JOIN "Instance" i ON i.id = m."instanceId"
    WHERE m."messageTimestamp" BETWEEN ${DE} AND ${ATE} AND i.name = ANY(ARRAY[${nomes}])
    ORDER BY m."messageTimestamp") TO STDOUT`;

  const bruto = execFileSync('docker',
    ['exec', '-i', 'evolution-postgres', 'psql', '-U', 'evolution', '-d', 'evolution', '-tA', '-c', sql],
    { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' });

  const linhas = bruto.split('\n').filter((l) => l.trim());
  log(`${linhas.length} registros lidos do Evolution.`);

  // --- pipeline/estágio inicial por tenant (regra do ensurePipelineAndStage) ---
  const tenantsUsados = [...new Set(instancias.map((i) => i.tenant_id))];
  const ctxPorTenant = new Map();
  for (const t of tenantsUsados) {
    const p = await prisma.pipeline.findFirst({
      where: { tenant_id: t }, orderBy: { ordem: 'asc' },
      select: { id: true, stages: { orderBy: { ordem: 'asc' }, take: 1, select: { id: true } } },
    });
    if (p?.stages[0]) ctxPorTenant.set(t, { pipelineId: p.id, stageId: p.stages[0].id });
  }

  // --- normaliza tudo em memória ---
  const stats = { lido: 0, tipo: {}, grupo: 0, semFone: 0, semCtx: 0, erro: 0 };
  const itens = [];
  for (const linha of linhas) {
    let r; try { r = JSON.parse(linha); } catch { stats.erro++; continue; }
    stats.lido++;
    const tipo = TIPOS[r.tipo];
    if (!tipo) { stats.tipo[r.tipo] = (stats.tipo[r.tipo] ?? 0) + 1; continue; }
    if (r.jid?.includes('@g.us')) { stats.grupo++; continue; }
    const inst = doCrm.get(r.instancia); if (!inst) continue;
    const telefone = telefoneDe(r); if (!telefone) { stats.semFone++; continue; }
    if (!r.wa_id) { stats.erro++; continue; }
    const ctx = ctxPorTenant.get(inst.tenant_id); if (!ctx) { stats.semCtx++; continue; }
    itens.push({
      waId: r.wa_id, tipo, telefone, fromMe: r.from_me, quando: new Date(Number(r.ts) * 1000),
      conteudo: (r.texto?.trim()) || PLACEHOLDER[tipo] || null,
      pushName: (!r.from_me && r.push_name?.trim()) || null,
      midia: r.midia ?? null, tipoBruto: r.tipo,
      tenantId: inst.tenant_id, instNome: inst.nome, ownerId: inst.owner_user_id,
      pipelineId: ctx.pipelineId, stageId: ctx.stageId,
    });
  }
  log(`${itens.length} mensagens elegíveis apos filtros.`);

  // --- já existem? em lote, não uma consulta por mensagem ---
  const existentes = new Set();
  const ids = [...new Set(itens.map((i) => i.waId))];
  for (const [n, parte] of chunks(ids, 5000).entries()) {
    const achados = await prisma.message.findMany({
      where: { whatsapp_message_id: { in: parte } }, select: { whatsapp_message_id: true },
    });
    achados.forEach((a) => existentes.add(a.whatsapp_message_id));
    process.stdout.write(`\r  checando duplicatas... lote ${n + 1}/${Math.ceil(ids.length / 5000)}`);
  }
  log('');
  const novos = itens.filter((i) => !existentes.has(i.waId));
  log(`${novos.length} mensagens novas (${itens.length - novos.length} ja estavam no CRM).`);

  // --- leads: resolve em lote, cria os que faltam ---
  const grupos = new Map(); // tenantId|pipelineId → Map(telefone → {primeira, nome, inst, owner, stageId})
  for (const i of novos) {
    const g = `${i.tenantId}|${i.pipelineId}`;
    if (!grupos.has(g)) grupos.set(g, new Map());
    const m = grupos.get(g);
    const atual = m.get(i.telefone);
    if (!atual) m.set(i.telefone, { primeira: i.quando, nome: i.pushName, inst: i.instNome, owner: i.ownerId, stageId: i.stageId, tenantId: i.tenantId, pipelineId: i.pipelineId });
    else {
      if (i.quando < atual.primeira) atual.primeira = i.quando;
      if (!atual.nome && i.pushName) atual.nome = i.pushName;
    }
  }

  const leadId = new Map(); // tenantId|pipelineId|telefone → id
  let leadsACriar = 0;
  for (const [g, fones] of grupos) {
    const [tenantId, pipelineId] = g.split('|');
    const lista = [...fones.keys()];
    for (const parte of chunks(lista, 2000)) {
      const achados = await prisma.lead.findMany({
        where: { telefone: { in: parte }, pipeline_id: pipelineId, lead_scope: tenantId },
        select: { id: true, telefone: true },
      });
      achados.forEach((l) => leadId.set(`${g}|${l.telefone}`, l.id));
    }
    const faltando = lista.filter((f) => !leadId.has(`${g}|${f}`));
    leadsACriar += faltando.length;
    if (APPLY && faltando.length) {
      // Data REAL da mensagem: os relatórios daqueles dias já estão errados por
      // falta desses leads; retroagir corrige em vez de distorcer.
      await prisma.lead.createMany({
        data: faltando.map((f) => {
          const d = fones.get(f);
          return {
            nome: d.nome || f, telefone: f, position: -d.primeira.getTime(),
            origem: 'WHATSAPP_INCOMING', instancia_whatsapp: d.inst, lead_scope: tenantId,
            pipeline_id: pipelineId, estagio_id: d.stageId, estagio_entered_at: d.primeira,
            responsavel_id: d.owner, ultima_interacao: d.primeira,
            last_customer_message_at: d.primeira, tenant_id: tenantId, created_at: d.primeira,
          };
        }),
        skipDuplicates: true,
      });
      for (const parte of chunks(faltando, 2000)) {
        const achados = await prisma.lead.findMany({
          where: { telefone: { in: parte }, pipeline_id: pipelineId, lead_scope: tenantId },
          select: { id: true, telefone: true },
        });
        achados.forEach((l) => leadId.set(`${g}|${l.telefone}`, l.id));
      }
    }
  }
  log(`${leadsACriar} leads ${APPLY ? 'criados' : 'seriam criados'}.`);

  // --- mensagens em lote ---
  const comMidia = novos.filter((i) => i.midia).length;
  if (APPLY) {
    const prontos = novos.filter((i) => leadId.has(`${i.tenantId}|${i.pipelineId}|${i.telefone}`));
    const lotes = chunks(prontos, 500);
    for (const [n, lote] of lotes.entries()) {
      await prisma.message.createMany({
        data: lote.map((i) => ({
          lead_id: leadId.get(`${i.tenantId}|${i.pipelineId}|${i.telefone}`),
          instance_name: i.instNome, whatsapp_message_id: i.waId,
          direction: i.fromMe ? 'OUTGOING' : 'INCOMING', type: i.tipo, content: i.conteudo,
          status: 'DELIVERED', sender_type: 'system', tenant_id: i.tenantId, created_at: i.quando,
          media_mimetype: i.midia?.mimetype ?? null,
          media_filename: i.midia?.fileName ?? null,
          media_size_bytes: i.midia?.fileLength ? Number(i.midia.fileLength) : null,
          media_duration_seconds: i.midia?.seconds ?? null,
          media_width: i.midia?.width ?? null, media_height: i.midia?.height ?? null,
          // A fase 2 lê daqui para baixar e descriptografar.
          metadata: i.midia
            ? { backfill: true, backfill_media: { url: i.midia.url, mediaKey: i.midia.mediaKey, tipo: i.tipoBruto } }
            : { backfill: true },
        })),
        skipDuplicates: true,
      });
      process.stdout.write(`\r  gravando... lote ${n + 1}/${lotes.length}`);
    }
    log('');

    // ultima_interacao só AVANÇA: mensagem antiga não pode reordenar o Kanban
    // para trás nem apagar a interação real de hoje.
    const porLead = new Map();
    for (const i of prontos) {
      const id = leadId.get(`${i.tenantId}|${i.pipelineId}|${i.telefone}`);
      const t = porLead.get(id) ?? { ultima: i.quando, naoLidas: 0 };
      if (i.quando > t.ultima) t.ultima = i.quando;
      if (!i.fromMe) t.naoLidas++;
      porLead.set(id, t);
    }
    let n = 0;
    for (const [id, t] of porLead) {
      const atual = await prisma.lead.findUnique({ where: { id }, select: { ultima_interacao: true } });
      await prisma.lead.update({
        where: { id },
        data: {
          mensagens_nao_lidas: { increment: t.naoLidas },
          ultima_interacao: atual?.ultima_interacao && atual.ultima_interacao > t.ultima ? undefined : t.ultima,
        },
      });
      process.stdout.write(`\r  atualizando leads... ${++n}/${porLead.size}`);
    }
    log('');
  }

  log('\nRESULTADO');
  log('  registros lidos.............', stats.lido);
  log('  mensagens a importar.......', novos.length, APPLY ? '(gravadas)' : '(seriam gravadas)');
  log('    dessas, com midia........', comMidia);
  log('  leads.......................', leadsACriar, APPLY ? '(criados)' : '(seriam criados)');
  log('  ja existiam no CRM.........', itens.length - novos.length);
  log('  pulados: grupo.............', stats.grupo);
  log('  pulados: sem telefone......', stats.semFone);
  log('  pulados: tenant sem funil..', stats.semCtx);
  log('  erros......................', stats.erro);
  log('  pulados por tipo (evento de sistema, sem equivalente no CRM):');
  for (const [t, n] of Object.entries(stats.tipo).sort((a, b) => b[1] - a[1])) log(`    ${t}: ${n}`);
  if (!APPLY) log('\n--dry-run: NADA foi gravado. Rode com --apply para valer.');
}

main().catch((e) => { console.error('ERRO:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
