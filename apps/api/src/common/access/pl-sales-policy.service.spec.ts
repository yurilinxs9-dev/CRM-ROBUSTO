import { ForbiddenException } from '@nestjs/common';
import { PlSalesPolicyService } from './pl-sales-policy.service';
import type { AuthUser } from '../types/auth-user';

const tenant = 'a44772ed-1382-4400-84fc-3fa350e23e42';
const pipeline = '6f749216-8d83-44ed-8fd0-1c57720c9f11';
const own = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const item = '33333333-3333-4333-8333-333333333333';
const stage = '44444444-4444-4444-8444-444444444444';
const user = { id: 'seller', tenantId: tenant, role: 'OPERADOR', plSalesOnly: true } as AuthUser;

function setup() {
  const prisma = {
    lead: {
      findFirst: jest.fn(async ({ where }) => where.id === own && where.tenant_id === tenant && where.responsavel_id === user.id ? { id: own, pipeline_id: pipeline } : null),
      count: jest.fn(async ({ where }) => where.id.in.filter((id: string) => id === own).length),
    },
    stage: { findFirst: jest.fn(async ({ where }) => where.id === stage && where.tenant_id === tenant && where.pipeline_id === pipeline ? { id: stage } : null) },
    message: { findFirst: jest.fn().mockResolvedValue({ lead_id: own }) },
    task: { findFirst: jest.fn().mockResolvedValue({ lead_id: own }) },
    pushSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const policy = new PlSalesPolicyService(prisma as never);
  const request = (method: string, url: string, body?: Record<string, unknown>, query?: Record<string, unknown>, actor = user) => ({ method, originalUrl: url, body, query, user: actor });
  const check = (...args: Parameters<typeof request>) => policy.assertAllowed(request(...args));
  return { prisma, request, policy, check };
}

describe('PL API deny-by-default policy', () => {
  it.each(['/partners', '/partners/team', '/financeiro/dashboard', '/dashboard/stats', '/analytics', '/attribution/summary', '/admin', '/tenants/me', '/companies', '/contacts', '/users/team', '/leads/duplicates', '/leads/new-feature', '/pl-sales/audit'])('denies %s', async path => {
    await expect(setup().check('GET', `/api${path}`)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['claim', 'reassign', 'return-to-pool', 'move-to-sector', 'merge'])('denies %s even on own lead', async action => {
    await expect(setup().check('POST', `/api/leads/${own}/${action}`)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['/leads/bulk/assign', '/leads/sync-profiles', '/pipelines', '/tags', '/users/team', '/messages/unknown'])('denies global mutation %s', async path => {
    await expect(setup().check('POST', path)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['/leads', '/leads/export', '/pipelines', `/pipelines/${pipeline}`, '/tags', '/sectors', '/lead-views', '/custom-fields/schema', '/users/list', '/auth/me', '/notifications', '/instances', '/pl-sales', '/pl-sales/candidates', '/announcements/active'])('allows scoped read %s', async path => {
    await expect(setup().check('GET', path)).resolves.toBeUndefined();
  });
  it.each(['', '/messages', '/activities', '/timeline', '/media', '/contacts', '/insight', '/lembretes'])('checks current owner for lead child %s', async child => {
    const m = setup();
    await expect(m.check('GET', `/api/leads/${own}${child}`)).resolves.toBeUndefined();
    await expect(m.check('GET', `/api/leads/${foreign}${child}`)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('accepts prefix/case/trailing slash/query variants without broad prefix matching', async () => {
    const m = setup();
    await expect(m.check('GET', `/API/LEADS/${own}/?x=1`)).resolves.toBeUndefined();
    for (const path of ['/api/leads-evil', '/api//leads', '/api/leads%2fduplicates', '/api/leads/%2e%2e/partners', '/api/leads/%zz']) {
      await expect(m.check('GET', path)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('allows other profiles without database queries', async () => {
    const m = setup();
    for (const actor of [{ ...user, plSalesOnly: false }, { ...user, tenantId: 'other' }, { ...user, role: 'GERENTE' }]) {
      await expect(m.check('GET', '/partners', undefined, undefined, actor as AuthUser)).resolves.toBeUndefined();
    }
    expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
  });
  it('pins new lead owner and pipeline, rejects forged owner/pipeline/stage', async () => {
    const m = setup(); const req = m.request('POST', '/leads', { nome: 'A' });
    await m.policy.assertAllowed(req);
    expect(req.body).toMatchObject({ responsavel_id: user.id, pipeline_id: pipeline });
    for (const body of [{ responsavel_id: 'other' }, { pipeline_id: foreign }, { estagio_id: foreign }]) {
      await expect(m.check('POST', '/leads', body)).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(m.check('POST', '/leads', { estagio_id: stage })).resolves.toBeUndefined();
  });
  it.each([{ responsavel_id: foreign }, { responsavel_id: null }, { pipeline_id: foreign }, { estagio_id: foreign }, { company_id: foreign }])('denies forged PATCH references %j', async body => {
    await expect(setup().check('PATCH', `/leads/${own}`, body)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('checks target stage belongs to current pipeline and every bulk ID is owned', async () => {
    const m = setup();
    await expect(m.check('PATCH', `/leads/${own}/stage`, { estagio_id: stage })).resolves.toBeUndefined();
    await expect(m.check('PATCH', `/leads/${own}/stage`, { estagio_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    for (const action of ['move-stage', 'tag', 'archive']) {
      await expect(m.check('POST', `/leads/bulk/${action}`, { ids: [own], estagio_id: stage })).resolves.toBeUndefined();
      await expect(m.check('POST', `/leads/bulk/${action}`, { ids: [own, foreign], estagio_id: stage })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(m.check('POST', `/leads/bulk/${action}`, { ids: [] })).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it.each(['send-text', 'send-media-ref', 'internal-note'])('checks JSON send %s and denies malformed references', async action => {
    const m = setup();
    await expect(m.check('POST', `/messages/${action}`, { lead_id: own })).resolves.toBeUndefined();
    for (const value of [foreign, null, [own], { id: own }, '']) {
      await expect(m.check('POST', `/messages/${action}`, { lead_id: value })).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('allows only the two multipart sends before the interceptor parses body', async () => {
    const m = setup();
    await expect(m.check('POST', '/messages/send-audio')).resolves.toBeUndefined();
    await expect(m.check('POST', '/messages/send-media')).resolves.toBeUndefined();
    await expect(m.check('POST', '/messages/send-text')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('does not permit internal note mentions to leak to colleagues', async () => {
    await expect(setup().check('POST', '/messages/internal-note', { lead_id: own, mentioned_user_ids: [foreign] })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('checks history/sync, media upload, message media/resend ownership', async () => {
    const m = setup();
    for (const [method, path] of [['GET', `/messages/history/${own}`], ['POST', `/messages/sync-chat/${own}`], ['GET', `/messages/${item}/media`], ['POST', `/messages/${item}/resend`]]) {
      await expect(m.check(method, path)).resolves.toBeUndefined();
    }
    await expect(m.check('POST', '/media/upload-url', { lead_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    m.prisma.message.findFirst.mockResolvedValue({ lead_id: foreign });
    await expect(m.check('GET', `/messages/${item}/media`)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.check('POST', `/messages/${item}/resend`)).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: item, tenant_id: tenant } }));
  });
  it('checks task ownership plus both old and new lead references', async () => {
    const m = setup();
    await expect(m.check('GET', `/tasks/${item}`)).resolves.toBeUndefined();
    expect(m.prisma.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: item, tenant_id: tenant, responsavel_id: user.id } }));
    await expect(m.check('POST', '/tasks', { lead_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.check('GET', '/tasks', undefined, { lead_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.check('PATCH', `/tasks/${item}`, { lead_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    m.prisma.task.findFirst.mockResolvedValue({ lead_id: foreign });
    await expect(m.check('POST', `/tasks/${item}/complete`)).rejects.toBeInstanceOf(ForbiddenException);
    m.prisma.task.findFirst.mockResolvedValue(null);
    await expect(m.check('DELETE', `/tasks/${item}`)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('checks query/body references independently and fails closed on lookup failure', async () => {
    const m = setup();
    await expect(m.check('POST', '/tasks', { lead_id: own }, { lead_id: foreign })).rejects.toBeInstanceOf(ForbiddenException);
    m.prisma.lead.findFirst.mockRejectedValue(new Error('database offline'));
    await expect(m.check('GET', `/leads/${own}`)).rejects.toThrow();
  });
});
