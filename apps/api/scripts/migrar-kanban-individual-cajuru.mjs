/**
 * One-shot: liga o kanban individual da Cajuru Interiores.
 *
 * O tenant ja operava "kanban individual na gambiarra": em 27/08 a Isamara criou
 * 9 colunas novas no modelo COMPARTILHADO, e o board dos outros cinco membros
 * mudou junto. Este script desfaz a gambiarra pelo caminho oficial da feature:
 *   - as 9 colunas de 27/08 viram colunas PESSOAIS da Isamara (Stage.user_id);
 *   - os 6 membros ativos (Isamara inclusa) ganham clone das 9 colunas antigas;
 *   - cada lead vai para o clone do proprio responsavel, mesma etapa;
 *   - leads de outros membros presos nas colunas da Isamara caem no "Em contato"
 *     do dono (fallback aprovado pelo Yuri na spec);
 *   - Tenant.kanban_individual = true.
 * Resultado: o board de quem nao e a Isamara volta a ser o de antes de 27/08.
 *
 * Uso (mesmo padrao de scripts/introspect-db.mjs: le apps/api/.env, DIRECT_URL):
 *   node scripts/migrar-kanban-individual-cajuru.mjs            # dry-run (DEFAULT)
 *   node scripts/migrar-kanban-individual-cajuru.mjs --apply    # executa a transacao
 *
 * Spec: docs/superpowers/specs/2026-09-01-kanban-individual-design.md ("Migracao Cajuru").
 */
import { readFileSync } from 'fs';
import { PrismaClient, Prisma } from '@prisma/client';

// ---------------------------------------------------------------- constantes

const TENANT = 'bb4953ac-b37f-4445-81c0-f54508c77141';
const ISAMARA = 'dc416756-a583-447b-9e62-cc63e132bf00';
/** Colunas criadas a partir daqui sao as que a Isamara adicionou em 27/08. */
const CORTE = new Date('2026-08-27T00:00:00Z');

/** As 9 colunas originais do tenant. Divergiu? Aborta: o mapa deste script parou de valer. */
const ANTIGAS_ESPERADAS = [
  'Novo',
  'Em contato',
  'Qualificado',
  'Ganho',
  'Perdido',
  'Aguardando orçamento',
  'Retorno para cliente',
  'SEM RETORNO',
  'Empresa / Representantes',
];

/** Quantas colunas a Isamara criou em 27/08. Divergencia so vira aviso no relatorio. */
const DA_ISAMARA_ESPERADAS = 9;

/** Papeis que ganham board proprio — espelha PAPEIS_COM_BOARD do KanbanIndividualService. */
const PAPEIS_COM_BOARD = ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'];

/** Destino dos leads de outros membros presos nas colunas da Isamara. */
const FALLBACK_ORFAOS = 'Em contato';

const APPLY = process.argv.includes('--apply');

// ------------------------------------------------------------------- helpers

const normalizar = (nome) => nome.toLowerCase().trim();

/** Campos copiados no clone — mesma lista do cloneBaseForUser (SLA/cadencia precisam valer no board pessoal). */
function dadosDoClone(base, userId) {
  return {
    nome: base.nome,
    cor: base.cor,
    ordem: base.ordem,
    pipeline_id: base.pipeline_id,
    tenant_id: TENANT,
    user_id: userId,
    is_won: base.is_won,
    is_lost: base.is_lost,
    max_dias: base.max_dias,
    probabilidade: base.probabilidade,
    auto_action: base.auto_action ?? Prisma.JsonNull,
    campos_obrigatorios: base.campos_obrigatorios ?? Prisma.JsonNull,
    sla_config: base.sla_config ?? Prisma.JsonNull,
    idle_alert_config: base.idle_alert_config ?? Prisma.JsonNull,
    response_alert_config: base.response_alert_config ?? Prisma.JsonNull,
    on_entry_config: base.on_entry_config ?? Prisma.JsonNull,
    cadence_config: base.cadence_config ?? Prisma.JsonNull,
  };
}

function abortar(msg) {
  console.error(`\nABORTADO: ${msg}\n`);
  process.exitCode = 1;
}

const linha = (c = '-') => c.repeat(78);

// --------------------------------------------------------------------- setup

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const direct = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim();
const url = direct || env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const origemUrl = direct ? 'DIRECT_URL' : 'DATABASE_URL (fallback)';

/**
 * O --apply e uma transacao INTERATIVA (varios statements no mesmo backend). O
 * pooler do Supabase em transaction mode (pgbouncer, :6543) devolve o backend
 * entre statements: a transacao estoura ou aplica pela metade. So a conexao
 * direta (:5432) serve. O dry-run e leitura solta, entao passa em qualquer uma.
 */
function descreverConexao(raw) {
  try {
    const u = new URL(raw);
    return {
      alvo: `${u.hostname}:${u.port || '(default)'}`,
      pooler: u.searchParams.get('pgbouncer') === 'true' || u.port === '6543',
    };
  } catch {
    return { alvo: '(url ilegivel)', pooler: /pgbouncer=true|:6543/.test(raw ?? '') };
  }
}
const conexao = descreverConexao(url);

const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  console.log(linha('='));
  console.log(`MIGRACAO KANBAN INDIVIDUAL — CAJURU INTERIORES  [${APPLY ? 'APPLY' : 'DRY-RUN'}]`);
  console.log(`tenant=${TENANT}  corte=${CORTE.toISOString()}  em ${new Date().toISOString()}`);
  console.log(`conexao: ${conexao.alvo}  (de ${origemUrl})${conexao.pooler ? '  [POOLER]' : ''}`);
  console.log(linha('='));

  // ------------------------------------------------------------- 1. guardas

  if (APPLY && conexao.pooler) {
    abortar(
      `--apply exige conexao DIRETA, e ${conexao.alvo} e o pooler em transaction mode ` +
        `(pgbouncer=true ou :6543). Transacao interativa nesse pooler aplica pela metade.\n` +
        `  Ajuste DIRECT_URL para a porta 5432 do banco e rode de novo.`,
    );
    throw new Error('guarda');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT },
    select: { id: true, nome: true, kanban_individual: true },
  });
  if (!tenant) throw new Error(`Tenant ${TENANT} nao existe neste banco`);
  console.log(`\nTenant: ${tenant.nome}  kanban_individual=${tenant.kanban_individual}`);

  if (tenant.kanban_individual === true) {
    abortar('Tenant.kanban_individual JA esta true — a migracao ja rodou (ou o toggle foi ligado pela UI).');
    throw new Error('guarda');
  }

  const stages = await prisma.stage.findMany({
    where: { tenant_id: TENANT },
    orderBy: { ordem: 'asc' },
  });

  const jaPessoais = stages.filter((s) => s.user_id !== null);
  if (jaPessoais.length > 0) {
    abortar(
      `${jaPessoais.length} Stage(s) do tenant JA tem user_id preenchido — estado misto, migracao manual.\n` +
        jaPessoais.map((s) => `  ${s.id} ${s.nome} -> ${s.user_id}`).join('\n'),
    );
    throw new Error('guarda');
  }

  // O plano inteiro (clone 1:1, fallback por nome) assume UM pipeline. Com dois,
  // "as 9 antigas" deixaria de ser um conjunto e o fallback cruzaria pipeline.
  const pipelines = new Set(stages.map((s) => s.pipeline_id));
  if (pipelines.size !== 1) {
    abortar(`O tenant tem ${pipelines.size} pipelines com colunas — este script cobre so 1.`);
    throw new Error('guarda');
  }

  // -------------------------------------------- 2. antigas x colunas da Isamara

  const antigas = stages.filter((s) => s.created_at < CORTE).sort((a, b) => a.ordem - b.ordem);
  const daIsamara = stages.filter((s) => s.created_at >= CORTE).sort((a, b) => a.ordem - b.ordem);

  const nomesAntigas = antigas.map((s) => normalizar(s.nome)).sort();
  const nomesEsperados = ANTIGAS_ESPERADAS.map(normalizar).sort();
  const divergencia =
    antigas.length !== ANTIGAS_ESPERADAS.length ||
    nomesAntigas.some((n, i) => n !== nomesEsperados[i]);

  if (divergencia) {
    abortar(
      `As colunas anteriores ao corte nao batem com as 9 esperadas.\n` +
        `  esperado (${ANTIGAS_ESPERADAS.length}): ${ANTIGAS_ESPERADAS.join(' | ')}\n` +
        `  encontrado (${antigas.length}): ${antigas.map((s) => s.nome).join(' | ')}`,
    );
    throw new Error('guarda');
  }
  console.log(`Guardas OK: toggle desligado, nenhuma Stage pessoal, ${antigas.length} colunas antigas conferem.`);

  const avisos = [];
  if (daIsamara.length !== DA_ISAMARA_ESPERADAS) {
    avisos.push(
      `colunas pos-corte: ${daIsamara.length} (esperado ${DA_ISAMARA_ESPERADAS}) — ` +
        `todas viram da Isamara mesmo assim: ${daIsamara.map((s) => s.nome).join(' | ')}`,
    );
  }

  // Colisao de nome no board da Isamara: ela fica com a coluna pos-corte E com o
  // clone da antiga de mesmo nome normalizado. stageForOwner/stageForBase casam
  // por nome case-insensitive com findFirst — com duas candidatas o destino de um
  // reassign para ela deixa de ser deterministico. Nao aborta (a colisao ja existe
  // hoje no board compartilhado), mas tem que aparecer antes de alguem aplicar.
  const nomesDasAntigas = new Set(antigas.map((s) => normalizar(s.nome)));
  for (const s of daIsamara) {
    if (!nomesDasAntigas.has(normalizar(s.nome))) continue;
    const antiga = antigas.find((a) => normalizar(a.nome) === normalizar(s.nome));
    avisos.push(
      `COLISAO DE NOME no board da Isamara: "${s.nome}" (pos-corte, ordem ${s.ordem}) ` +
        `normaliza igual a "${antiga.nome}" (antiga, ordem ${antiga.ordem}), da qual ela recebe clone. ` +
        `stageForOwner casa por nome case-insensitive: reassign para ela vira destino nao-deterministico. ` +
        `Renomear uma das duas ANTES do --apply resolve.`,
    );
  }

  /**
   * Colisao de ORDEM no board da Isamara. O clone de cada antiga nasce com a
   * `ordem` da base, e as colunas pos-corte mantem a delas — as duas faixas
   * convivem no MESMO board (so o dela). Dois estragos possiveis:
   *   - ordem IGUAL a de um clone: duas colunas na mesma posicao, e qual vem
   *     antes passa a depender do desempate do banco (muda entre recargas);
   *   - ordem ENTRE as dos clones: a coluna pessoal aparece intercalada no meio
   *     do funil base em vez de depois dele.
   * Nenhum dos dois perde lead, entao e aviso, nao aborta — mas tem que sair
   * nos dois modos, antes de alguem aplicar.
   */
  const ordensDosClones = [...new Set(antigas.map((s) => s.ordem))].sort((a, b) => a - b);
  const setDeOrdens = new Set(ordensDosClones);
  const ultimaDosClones = ordensDosClones.at(-1);
  const ordensIguais = daIsamara.filter((s) => setDeOrdens.has(s.ordem));
  const ordensIntercaladas = daIsamara.filter(
    (s) => !setDeOrdens.has(s.ordem) && s.ordem < ultimaDosClones,
  );
  const descrever = (lista) => lista.map((s) => `"${s.nome}" (ordem ${s.ordem})`).join(' | ');

  if (ordensIguais.length > 0) {
    avisos.push(
      `COLISAO DE ORDEM no board da Isamara: ${ordensIguais.length} coluna(s) pos-corte ficam na ` +
        `MESMA ordem de um clone das antigas (clones em ${ordensDosClones.join(',')}): ` +
        `${descrever(ordensIguais)}. Duas colunas na mesma posicao = ordem visual indefinida. ` +
        `Reordenar para ordem > ${ultimaDosClones} ANTES do --apply resolve.`,
    );
  }
  if (ordensIntercaladas.length > 0) {
    avisos.push(
      `ORDEM INTERCALADA no board da Isamara: ${ordensIntercaladas.length} coluna(s) pos-corte ficam ` +
        `no MEIO do funil base (clones em ${ordensDosClones.join(',')}): ${descrever(ordensIntercaladas)}. ` +
        `Nenhum lead se perde — o board dela abre com as colunas pessoais intercaladas entre as do ` +
        `modelo, que e como ela ja ve hoje. Reordenar para ordem > ${ultimaDosClones} agrupa tudo no fim.`,
    );
  }

  // ------------------------------------------------------------- 3. membros

  const membros = await prisma.user.findMany({
    where: { tenant_id: TENANT, ativo: true, role: { in: PAPEIS_COM_BOARD } },
    select: { id: true, nome: true, role: true },
    orderBy: { nome: 'asc' },
  });
  const isamara = membros.find((m) => m.id === ISAMARA);
  if (!isamara) {
    abortar(`Isamara (${ISAMARA}) nao esta entre os membros ativos com board do tenant.`);
    throw new Error('guarda');
  }

  // --------------------------------------------- 4. estado atual dos leads

  const porStage = await prisma.lead.groupBy({
    by: ['estagio_id', 'responsavel_id'],
    where: { tenant_id: TENANT },
    _count: { _all: true },
  });
  const contar = (estagioId, responsavelId) =>
    porStage.find((g) => g.estagio_id === estagioId && g.responsavel_id === responsavelId)?._count
      ._all ?? 0;
  const totalLeads = porStage.reduce((acc, g) => acc + g._count._all, 0);

  const idsMembros = new Set(membros.map((m) => m.id));
  const semDono = porStage.filter((g) => g.responsavel_id === null).reduce((a, g) => a + g._count._all, 0);
  const donoForaDoBoard = porStage
    .filter((g) => g.responsavel_id !== null && !idsMembros.has(g.responsavel_id))
    .reduce((a, g) => a + g._count._all, 0);

  console.log(`\n${linha()}`);
  console.log('ESTADO ATUAL (leitura do banco agora — a spec foi escrita em 01/09 de manha)');
  console.log(linha());
  console.log(`Leads no tenant: ${totalLeads}  |  sem responsavel: ${semDono}  |  responsavel sem board: ${donoForaDoBoard}`);
  console.log(`Membros ativos com board (${membros.length}): ${membros.map((m) => `${m.nome}/${m.role}`).join(', ')}`);
  console.log('\nColunas ANTIGAS (viram o modelo base, user_id continua null):');
  for (const s of antigas) {
    const n = porStage.filter((g) => g.estagio_id === s.id).reduce((a, g) => a + g._count._all, 0);
    console.log(`  ordem=${String(s.ordem).padStart(2)}  leads=${String(n).padStart(4)}  ${s.nome}`);
  }
  console.log('\nColunas DA ISAMARA (criadas >= corte; recebem user_id = Isamara):');
  for (const s of daIsamara) {
    const n = porStage.filter((g) => g.estagio_id === s.id).reduce((a, g) => a + g._count._all, 0);
    const dela = contar(s.id, ISAMARA);
    console.log(
      `  ordem=${String(s.ordem).padStart(2)}  leads=${String(n).padStart(4)} (da Isamara: ${dela})  ${s.nome}`,
    );
  }

  // --------------------------------------------------------------- 5. plano

  /**
   * Plano por membro: as 9 colunas antigas viram clones dele e os leads dele em
   * cada antiga acompanham. Os ids dos clones so existem no --apply; no dry-run
   * o destino e descrito pelo nome.
   */
  const plano = membros.map((membro) => {
    const movimentos = antigas
      .map((origem) => ({ origem, leads: contar(origem.id, membro.id) }))
      .filter((m) => m.leads > 0);
    return {
      membro,
      clones: antigas.length,
      movimentos,
      totalLeads: movimentos.reduce((a, m) => a + m.leads, 0),
    };
  });

  // Orfaos: leads de OUTROS membros presos nas colunas que viram da Isamara.
  // Os da Isamara ficam onde estao (a coluna passa a ser dela).
  const orfaosPorGrupo = [];
  for (const s of daIsamara) {
    for (const g of porStage.filter((x) => x.estagio_id === s.id)) {
      if (g.responsavel_id === ISAMARA) continue;
      const dono = g.responsavel_id === null ? null : membros.find((m) => m.id === g.responsavel_id);
      orfaosPorGrupo.push({
        origem: s,
        responsavelId: g.responsavel_id,
        dono,
        leads: g._count._all,
      });
    }
  }
  const orfaosMoveis = orfaosPorGrupo.filter((o) => o.dono !== undefined && o.dono !== null);
  const orfaosParados = orfaosPorGrupo.filter((o) => o.dono === undefined || o.dono === null);
  const totalOrfaosMoveis = orfaosMoveis.reduce((a, o) => a + o.leads, 0);

  // Detalhe nominal dos orfaos — sao poucos (spec: ~5) e o Yuri confere um a um.
  // O `take` so existe para o relatorio nao virar despejo se o numero explodir;
  // o total real continua nos agregados acima.
  const ORFAOS_DETALHE_MAX = 100;
  const orfaosDetalhe = orfaosMoveis.length
    ? await prisma.lead.findMany({
        where: {
          tenant_id: TENANT,
          estagio_id: { in: daIsamara.map((s) => s.id) },
          responsavel_id: { in: orfaosMoveis.map((o) => o.responsavelId) },
        },
        select: { id: true, nome: true, telefone: true, estagio_id: true, responsavel_id: true },
        orderBy: { nome: 'asc' },
        take: ORFAOS_DETALHE_MAX,
      })
    : [];

  console.log(`\n${linha()}`);
  console.log('PLANO — colunas a criar e leads a mover por membro');
  console.log(linha());
  for (const p of plano) {
    const marca = p.membro.id === ISAMARA ? '  (dona das 9 colunas de 27/08 — fica com 18 no total)' : '';
    console.log(`\n${p.membro.nome} [${p.membro.role}] ${p.membro.id}${marca}`);
    console.log(`  colunas a criar: ${p.clones} (clones das antigas, mesma ordem/cor/configs)`);
    if (p.movimentos.length === 0) {
      console.log('  leads a mover: 0');
    } else {
      for (const m of p.movimentos) {
        console.log(
          `    ${String(m.leads).padStart(4)} leads  ${m.origem.nome}  ->  ${m.origem.nome} (${p.membro.nome})`,
        );
      }
      console.log(`  subtotal: ${p.totalLeads} leads`);
    }
  }

  console.log(`\n${linha()}`);
  console.log('ORFAOS — leads de outros membros presos nas colunas da Isamara');
  console.log(linha());
  if (orfaosPorGrupo.length === 0) {
    console.log('  nenhum');
  } else {
    for (const o of orfaosMoveis) {
      console.log(
        `  ${String(o.leads).padStart(3)} leads  ${o.origem.nome}  ->  ${FALLBACK_ORFAOS} (${o.dono.nome})`,
      );
    }
    for (const l of orfaosDetalhe) {
      const origem = daIsamara.find((s) => s.id === l.estagio_id);
      const dono = membros.find((m) => m.id === l.responsavel_id);
      console.log(
        `      - ${l.nome} (${l.telefone})  dono=${dono?.nome ?? '?'}  ${origem?.nome ?? '?'} -> ${FALLBACK_ORFAOS}`,
      );
    }
    if (totalOrfaosMoveis > ORFAOS_DETALHE_MAX) {
      console.log(`      ... (${totalOrfaosMoveis - ORFAOS_DETALHE_MAX} leads omitidos do detalhe nominal)`);
    }
    for (const o of orfaosParados) {
      console.log(
        `  ${String(o.leads).padStart(3)} leads  ${o.origem.nome}  ->  PERMANECEM (responsavel ${o.responsavelId ?? 'null'} sem board)`,
      );
    }
  }

  const totalMovidos = plano.reduce((a, p) => a + p.totalLeads, 0) + totalOrfaosMoveis;
  const clonesTotal = plano.reduce((a, p) => a + p.clones, 0);

  console.log(`\n${linha()}`);
  console.log('TOTAIS');
  console.log(linha());
  console.log(`  colunas a criar (clones):        ${clonesTotal}  (${membros.length} membros x ${antigas.length})`);
  console.log(`  colunas a marcar como da Isamara: ${daIsamara.length}`);
  console.log(`  leads a mover (clones):          ${totalMovidos - totalOrfaosMoveis}`);
  console.log(`  leads a mover (orfaos):          ${totalOrfaosMoveis}`);
  console.log(`  leads a mover (total):           ${totalMovidos}`);
  console.log(`  leads que NAO se movem:          ${totalLeads - totalMovidos}  (da Isamara nas colunas dela, sem responsavel, ou dono sem board)`);
  console.log(`  Tenant.kanban_individual:        false -> true`);
  if (avisos.length) {
    console.log('\nAVISOS:');
    for (const a of avisos) console.log(`  ! ${a}`);
  }

  // ---------------------------------------------------------------- 6. apply

  if (!APPLY) {
    console.log(`\n${linha('=')}`);
    console.log('DRY-RUN — nada foi gravado. Rode com --apply para executar a transacao.');
    console.log(linha('='));
  } else {
    console.log(`\n${linha('=')}`);
    console.log('APLICANDO (transacao unica)...');
    const feito = await prisma.$transaction(
      async (tx) => {
        // Reler o toggle DENTRO da transacao: entre a guarda la de cima e este
        // commit alguem pode ter ligado pela UI (POST /api/kanban-individual, que
        // ja clona a base pra todo mundo). Sem esta trava o script clonaria a
        // segunda leva por cima e o board sairia com colunas duplicadas.
        const atual = await tx.tenant.findUnique({
          where: { id: TENANT },
          select: { kanban_individual: true },
        });
        if (atual?.kanban_individual === true) {
          throw new Error(
            'kanban_individual virou true durante a execucao (enable pela UI?) — transacao revertida, nada foi gravado',
          );
        }

        // As colunas de 27/08 passam a ser dela.
        const marcadas = await tx.stage.updateMany({
          where: { id: { in: daIsamara.map((s) => s.id) } },
          data: { user_id: ISAMARA },
        });

        let clonesCriados = 0;
        let leadsMovidos = 0;
        /** membroId -> (nome normalizado da coluna antiga -> id do clone) */
        const clonePorMembro = new Map();

        for (const membro of membros) {
          const mapa = new Map();
          for (const base of antigas) {
            const clone = await tx.stage.create({ data: dadosDoClone(base, membro.id) });
            mapa.set(normalizar(base.nome), clone.id);
            clonesCriados += 1;
          }
          clonePorMembro.set(membro.id, mapa);

          for (const base of antigas) {
            const destino = mapa.get(normalizar(base.nome));
            const r = await tx.lead.updateMany({
              where: { tenant_id: TENANT, responsavel_id: membro.id, estagio_id: base.id },
              data: { estagio_id: destino },
            });
            leadsMovidos += r.count;
          }
        }

        // Orfaos: cada dono recebe os seus no proprio "Em contato".
        let orfaosMovidos = 0;
        for (const o of orfaosMoveis) {
          const destino = clonePorMembro.get(o.dono.id)?.get(normalizar(FALLBACK_ORFAOS));
          if (!destino) continue;
          const r = await tx.lead.updateMany({
            where: {
              tenant_id: TENANT,
              responsavel_id: o.dono.id,
              estagio_id: o.origem.id,
            },
            data: { estagio_id: destino },
          });
          orfaosMovidos += r.count;
        }

        await tx.tenant.update({ where: { id: TENANT }, data: { kanban_individual: true } });

        return { marcadas: marcadas.count, clonesCriados, leadsMovidos, orfaosMovidos };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    console.log('FEITO:');
    console.log(`  colunas marcadas como da Isamara: ${feito.marcadas}`);
    console.log(`  clones criados:                   ${feito.clonesCriados}`);
    console.log(`  leads movidos para clones:        ${feito.leadsMovidos}`);
    console.log(`  leads orfaos movidos:             ${feito.orfaosMovidos}`);
    console.log(`  Tenant.kanban_individual:         true`);
    console.log('  ATENCAO: o script nao emite WebSocket. Quem estiver com o kanban aberto');
    console.log('  precisa recarregar a pagina para ver o board novo.');
    console.log(linha('='));
  }
} catch (e) {
  if (String(e.message) !== 'guarda') {
    console.error('\nERRO:', String(e).slice(0, 800));
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
