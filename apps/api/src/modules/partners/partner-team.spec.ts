import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { PARTNER_TENANT_ID } from './partners.domain';
import { authorizeTeam, parseTeam, teamCreateSchema, teamDedupeKey, teamProgress, teamUpdateSchema } from './partner-team.domain';
import { PartnerTeamService } from './partner-team.service';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const user: AuthUser = { id, tenantId: PARTNER_TENANT_ID, role: 'OPERADOR', ativo: true, nome: 'Consultora', email: 'local@example.test' };
const input = { request_id: other, kind: 'registration', subject_type: 'lead', subject_id: other, consultant_id: id, occurred_on: '2026-01-15', occurred_time: '09:00', company_name: 'Empresa' };
describe('partner team business rules', () => {
  it('counts an effective registration once regardless of the month or hour', () => {
    expect(teamDedupeKey('registration', `lead:${id}`, '2026-01-01', '08:00')).toBe(teamDedupeKey('registration', `lead:${id}`, '2026-02-15', '12:00'));
    expect(teamDedupeKey('registration', `lead:${id}`, '', '')).not.toBe(teamDedupeKey('registration', `lead:${other}`, '', ''));
  });
  it('distinguishes separate meetings but deduplicates the same company/time', () => {
    expect(teamDedupeKey('meeting', id, '2026-01-01', '10:00')).not.toBe(teamDedupeKey('meeting', id, '2026-01-01', '11:00'));
    expect(teamDedupeKey('meeting', id, '2026-01-01', '10:00')).not.toBe(teamDedupeKey('training', id, '2026-01-01', '10:00'));
  });
  it('calculates the agreed 5 of 8 example and distinguishes absent, zero and exceeded goals', () => {
    expect(teamProgress(5, 8)).toEqual({ target: 8, remaining: 3, percentage: 62.5 });
    expect(teamProgress(5, null)).toEqual({ target: null, remaining: null, percentage: null });
    expect(teamProgress(0, 0)).toEqual({ target: 0, remaining: 0, percentage: null });
    expect(teamProgress(10, 8)).toEqual({ target: 8, remaining: 0, percentage: 125 });
  });
  it('rejects impossible/future completion dates and foreign fields', () => {
    expect(() => parseTeam(teamCreateSchema, { ...input, occurred_on: '2026-02-30' })).toThrow();
    expect(() => parseTeam(teamCreateSchema, { ...input, occurred_on: '2099-01-01' })).toThrow();
    expect(() => parseTeam(teamCreateSchema, { ...input, tenant_id: 'other' })).toThrow();
    expect(() => parseTeam(teamCreateSchema, { ...input, occurred_time: '24:01' })).toThrow();
  });
  it('does not permit changing the company or event type when correcting an event', () => {
    expect(() => parseTeam(teamUpdateSchema, { consultant_id: id, occurred_on: '2026-01-01', occurred_time: '08:00', expectedVersion: 1, kind: 'registration' })).toThrow();
  });
  it('denies foreign tenants, inactive callers, and writes from viewers', () => {
    for (const caller of [{ ...user, tenantId: 'other' }, { ...user, ativo: false }, { ...user, role: 'VISUALIZADOR' as const }]) expect(() => authorizeTeam(caller, true)).toThrow(ForbiddenException);
    expect(() => authorizeTeam({ ...user, role: 'VISUALIZADOR' })).not.toThrow();
  });
});

function fixture() {
  const tx = { user: { findFirst: jest.fn().mockResolvedValue({ id, nome: user.nome }) }, partnerTeamActivity: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null) }, salesPartner: { findFirst: jest.fn().mockResolvedValue(null) }, lead: { findFirst: jest.fn().mockResolvedValue(null) } };
  const db = { ...tx, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const service = new PartnerTeamService(db as unknown as PrismaService, {} as CrmGateway);
  return { service, db, tx };
}
describe('partner team permission boundaries', () => {
  it('rejects operator attribution to another user before reading their data', async () => {
    const f = fixture(); await expect(f.service.create(user, { ...input, consultant_id: other })).rejects.toBeInstanceOf(ForbiddenException); expect(f.tx.user.findFirst).not.toHaveBeenCalled();
  });
  it('requires a lead from the current tenant', async () => {
    const f = fixture(); await expect(f.service.create(user, input)).rejects.toBeInstanceOf(NotFoundException); expect(f.tx.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: other, tenant_id: PARTNER_TENANT_ID } }));
  });
  it('does not permit operators to change targets or other consultants events', async () => {
    const f = fixture(); await expect(f.service.goal(user, id, '2026-01', { target: 8, expectedVersion: 0 })).rejects.toBeInstanceOf(ForbiddenException);
    f.tx.partnerTeamActivity.findFirst.mockResolvedValue({ id: other, consultant_id: other });
    await expect(f.service.cancel(user, other, { expectedVersion: 1, cancelled: true, reason: 'Duplicado' })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects another tenant before any query', async () => {
    const f = fixture(); await expect(f.service.dashboard({ ...user, tenantId: 'other' }, {})).rejects.toBeInstanceOf(ForbiddenException); expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
