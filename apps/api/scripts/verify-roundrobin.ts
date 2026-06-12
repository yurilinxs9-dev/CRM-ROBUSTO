/* eslint-disable no-console */
// F-02 — Verificação standalone do round-robin (jest não está instalado neste
// workspace). Reproduz os critérios de aceite com um fake de transação que
// simula a tabela QueuePointer em memória. Rodar:
//   ../../node_modules/.bin/ts-node --transpile-only scripts/verify-roundrobin.ts
import { AssignmentService } from '../src/modules/queue/assignment.service';

type User = { id: string };

function makeFakeTx(pointers: Map<string, number>, users: User[]) {
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('INSERT INTO "QueuePointer"')) {
        const sectorId = vals[0] as string;
        if (!pointers.has(sectorId)) pointers.set(sectorId, 0);
      } else if (sql.includes('UPDATE "QueuePointer"')) {
        pointers.set(vals[1] as string, vals[0] as number);
      }
      return 1;
    },
    $queryRaw: async (_s: TemplateStringsArray, ...vals: unknown[]) => [
      { current_index: pointers.get(vals[0] as string) ?? 0 },
    ],
    user: { findMany: async () => users },
    assignmentLog: { create: async () => ({}) },
  };
}

function makeService(pointers: Map<string, number>, users: User[]) {
  const fakeTx = makeFakeTx(pointers, users);
  const prisma = { $transaction: (cb: (t: unknown) => unknown) => cb(fakeTx) };
  return new AssignmentService(prisma as never);
}

const T = 'tenant-1';
const S = 'sector-1';
let failures = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

async function main() {
  // 1) A,B,A,B,A
  {
    const p = new Map<string, number>();
    const svc = makeService(p, [{ id: 'a' }, { id: 'b' }]);
    const seq: (string | null)[] = [];
    for (let i = 0; i < 5; i++) seq.push((await svc.assignBySector(T, S, `l${i}`)).userId);
    assert('distribui A,B,A,B,A (2 vendedores, 5 leads)', JSON.stringify(seq) === JSON.stringify(['a', 'b', 'a', 'b', 'a']), `got ${JSON.stringify(seq)}`);
  }
  // 2) Restart preserva posição
  {
    const p = new Map<string, number>();
    const s1 = makeService(p, [{ id: 'a' }, { id: 'b' }]);
    for (let i = 0; i < 3; i++) await s1.assignBySector(T, S, `l${i}`); // a,b,a → ponteiro=1
    const s2 = makeService(p, [{ id: 'a' }, { id: 'b' }]); // restart, mesmo "banco"
    const next = (await s2.assignBySector(T, S, 'l3')).userId;
    assert('restart não perde a posição (continua em b)', next === 'b', `got ${next}`);
  }
  // 3) Sem agentes → espera
  {
    const p = new Map<string, number>();
    const svc = makeService(p, []);
    const r = await svc.assignBySector(T, S, 'lx');
    assert('setor sem agentes → espera (null/waiting_no_agents)', r.userId === null && r.reason === 'waiting_no_agents');
  }
  // 4) Inativação mid-rodízio → sempre agente ativo
  {
    const p = new Map<string, number>();
    const s3 = makeService(p, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await s3.assignBySector(T, S, 'l0'); // a, next=1
    await s3.assignBySector(T, S, 'l1'); // b, next=2
    const s2 = makeService(p, [{ id: 'a' }, { id: 'b' }]); // c inativado
    const r = await s2.assignBySector(T, S, 'l2'); // 2 % 2 = 0 → a
    assert('inativação mid-rodízio cai em agente ativo', r.userId === 'a', `got ${r.userId}`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
