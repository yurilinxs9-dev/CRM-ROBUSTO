import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { readPlFirstResponse } from './pl-first-response';
import { PL_TENANT } from '../pl-sales/pl-sales.domain';
import { Prisma as Sql } from '@prisma/client';

const user: AuthUser = { id: 'seller', tenantId: PL_TENANT, role: 'OPERADOR', plSalesOnly: true, nome: 'Comercial PL', email: 'seller@example.test', ativo: true };
const from = new Date('2026-10-01T03:00:00Z');
const to = new Date('2026-11-01T02:59:59.999Z');
function setup(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  const prisma = { $queryRaw: query } as unknown as Pick<PrismaService, '$queryRaw'>;
  return { query, prisma };
}
function statement(query: jest.Mock): Prisma.Sql {
  const [strings, ...values] = query.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return Sql.sql(strings, ...values);
}

describe('shared PL first-response aggregate', () => {
  it('accepts native phone echoes only on her exclusive personal instance and matching owned conversation', async () => {
    const { query, prisma } = setup();
    await readPlFirstResponse(prisma, user, from, to);
    const sql = statement(query);
    // The alternative requires a NULL author: explicit colleague replies never
    // inherit lead/instance ownership, even when sent on her phone connection.
    expect(sql.text).toMatch(/reply\.sent_by_user_id = \$\d+\s+OR \(reply\.sent_by_user_id IS NULL AND EXISTS/);
    expect(sql.text).toMatch(/instance\.owner_user_id = \$\d+/);
    expect(sql.text).toMatch(/instance\.tenant_id = l\.tenant_id/);
    expect(sql.text).toMatch(/instance\.nome = reply\.instance_name/);
    expect(sql.text).toMatch(/tenant\.pool_enabled = false/);
    expect(sql.text).toMatch(/NOT EXISTS \(\s+SELECT 1 FROM "UserInstance"/);
    expect(sql.text).toMatch(/mapping\.instance_id = instance\.id AND mapping\.user_id <> \$\d+/);
    expect(sql.text).toMatch(/owned\.id = reply\.conversation_id/);
    expect(sql.text).toMatch(/owned\.responsavel_id = \$\d+/);
    expect(sql.text).toMatch(/owned\.instancia_whatsapp = instance\.nome/);
    expect(sql.text).toMatch(/owned\.tenant_id = l\.tenant_id AND owned\.lead_id = l\.id/);
  });

  it('excludes earlier assignments, another conversation/instance and invisible messages from the response pair', async () => {
    const { query, prisma } = setup();
    await readPlFirstResponse(prisma, user, from, to);
    const sql = statement(query);
    expect(sql.text).toMatch(/GREATEST\(incoming\.created_at, l\.assumed_at, assignment\.assigned_at, conversation\.assumed_at\)/);
    expect(sql.text).toMatch(/activity\.tenant_id = l\.tenant_id/);
    expect(sql.text).toMatch(/activity\.dados_antes->>'responsavel_id' IS DISTINCT FROM activity\.dados_depois->>'responsavel_id'/);
    expect(sql.text).toMatch(/reply\.conversation_id IS NOT DISTINCT FROM first_incoming\.conversation_id/);
    expect(sql.text).toMatch(/reply\.instance_name = first_incoming\.instance_name/);
    expect(sql.text).toMatch(/incoming\.visible_to_user_id IS NULL OR incoming\.visible_to_user_id = \$\d+/);
    expect(sql.text).toMatch(/reply\.created_at >= first_incoming\.started_at/);
    expect(sql.values).toContain(from);
    expect(sql.values).toContain(to);
  });

  it('starts a pending customer wait at assignment, without reopening requests already answered before handoff', async () => {
    const { query, prisma } = setup();
    await readPlFirstResponse(prisma, user, from, to);
    const sql = statement(query);
    expect(sql.text).toMatch(/response\.created_at - first_incoming\.started_at/g);
    expect(sql.text).toMatch(/clock\.started_at >= \$\d+/);
    expect(sql.text).not.toMatch(/incoming\.created_at >= GREATEST/);
    expect(sql.text).toMatch(/handled\.tenant_id = l\.tenant_id AND handled\.lead_id = l\.id/);
    expect(sql.text).toMatch(/handled\.conversation_id IS NOT DISTINCT FROM incoming\.conversation_id/);
    expect(sql.text).toMatch(/handled\.instance_name = incoming\.instance_name/);
    expect(sql.text).toMatch(/handled\.sender_type = 'user'/);
    expect(sql.text).toMatch(/handled\.created_at >= incoming\.created_at AND handled\.created_at < clock\.started_at/);
  });

  it('returns unanswered conversations without inventing mean or median samples', async () => {
    const { query, prisma } = setup([{ total_conversations: 5, samples: 0, average_seconds: null, median_seconds: null }]);
    expect(await readPlFirstResponse(prisma, user, from, to)).toEqual({
      period: { from: from.toISOString(), to: to.toISOString() }, total_conversations: 5,
      unanswered: 5, average_seconds: null, samples: 0, users: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('treats an empty SQL stub as zero samples for Dashboard callers', async () => {
    const { prisma } = setup();
    expect(await readPlFirstResponse(prisma, user, from, to)).toEqual(expect.objectContaining({
      average_seconds: null, samples: 0, total_conversations: 0, unanswered: 0, users: [],
    }));
  });

  it('keeps the unrounded mean for dashboard minutes while preserving rounded analytics rows', async () => {
    const { prisma } = setup([{ total_conversations: 2, samples: 2, average_seconds: 60.25, median_seconds: 60.25 }]);
    const result = await readPlFirstResponse(prisma, user, from, to);
    expect(result.average_seconds).toBe(60.25);
    expect(result.users[0].avg_seconds).toBe(60);
  });

  it('fails closed if a caller passes an unverified restricted profile', async () => {
    const { query, prisma } = setup();
    await expect(readPlFirstResponse(prisma, { ...user, plSalesOnly: false }, from, to)).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });
});
