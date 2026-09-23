import type { Broadcast } from '@prisma/client';
import { dispatchWaitReason } from './broadcast-gate';
import { campaignSchema, audienceWhere } from './broadcast-config';
import { BroadcastSenderService } from './broadcast-sender.service';

const now = new Date('2026-09-23T15:00:00Z'); // Wednesday, noon in Brasília
const tenant = { broadcast_window_start: 9, broadcast_window_end: 18, broadcast_window_days: [1,2,3,4,5] };
const campaign = { id: 'b', tenant_id: 't', status: 'running', daily_limit: 30, throttle_seconds: 900, segment: null, last_dispatch_at: null } as Broadcast;

describe('Follow-up scheduling and validation', () => {
  it('keeps future campaigns waiting and respects company hours even with a wider campaign window', () => {
    expect(dispatchWaitReason({ ...campaign, segment: { scheduled_at: '2026-09-24T15:00:00Z' } }, tenant, now)).toContain('data programada');
    expect(dispatchWaitReason({ ...campaign, segment: { window_start: 0, window_end: 24 } }, tenant, new Date('2026-09-23T23:00:00Z'))).toContain('empresa');
  });
  it('allows only the intersection of days and hours', () => {
    expect(dispatchWaitReason({ ...campaign, segment: { window_days: [1,5] } }, tenant, now)).toContain('campanha');
    expect(dispatchWaitReason(campaign, tenant, now)).toBeNull();
    expect(dispatchWaitReason({ ...campaign, last_dispatch_at: new Date(now.getTime()-899000) }, tenant, now)).toContain('intervalo');
    expect(dispatchWaitReason({ ...campaign, status: 'paused' }, tenant, now)).not.toBeNull();
  });
  it('rejects empty manual selection and unsafe numeric limits', () => {
    const base = { name: 'Teste', mode: 'template', template: 'Olá' };
    for (const extra of [{ lead_ids: [] }, { throttle_seconds: 0 }, { daily_limit: 201 }, { daily_limit: 1.5 }, { window_start: 18, window_end: 9 }, { window_days: [] }]) {
      expect(campaignSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
  it('never drops tenant scoping when combining manual contacts and audience criteria', () => {
    const where = audienceWhere('tenant-a', { lead_ids: ['foreign-lead'], responsavel_id: 'owner', pipeline_id: 'pipeline', temperatura: 'FRIO' });
    expect(where).toMatchObject({ tenant_id: 'tenant-a', id: { in: ['foreign-lead'] }, responsavel_id: 'owner', pipeline_id: 'pipeline', temperatura: 'FRIO', estagio: { is_won: false, is_lost: false } });
  });
});

describe('Shared manual/automatic dispatch gate', () => {
  function setup({ count=0, current=campaign, latest=null as Broadcast|null } = {}) {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue([]),
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
      broadcast: { findFirst: jest.fn().mockResolvedValueOnce(current).mockResolvedValue(latest), update: jest.fn() },
      broadcastTarget: { count: jest.fn().mockResolvedValue(count), updateMany: jest.fn().mockResolvedValue({ count:0 }) },
    };
    const prisma = { $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx), lead: { findFirst: jest.fn() } };
    const messages = { sendText: jest.fn() };
    const sender = new BroadcastSenderService(prisma as never, messages as never, {} as never);
    return { tx, prisma, messages, sender };
  }
  beforeEach(()=>jest.useFakeTimers().setSystemTime(now));
  afterEach(()=>jest.useRealTimers());
  it('manual force cannot bypass quota', async () => {
    const { sender, tx, messages } = setup({ count:30 });
    const result = await sender.sendToTarget(campaign, { id:'target', lead_id:'lead' }, { force:true });
    expect(result.outcome).toBe('deferred');
    expect(tx.broadcastTarget.updateMany).not.toHaveBeenCalled();
    expect(messages.sendText).not.toHaveBeenCalled();
  });
  it('a second campaign cannot bypass the last campaign interval', async () => {
    const { sender, messages, tx } = setup({ latest: { ...campaign, id:'other', throttle_seconds:1800, last_dispatch_at:new Date(now.getTime()-100000) } });
    expect((await sender.sendToTarget(campaign,{id:'target',lead_id:'lead'})).outcome).toBe('deferred');
    expect(tx.broadcastTarget.updateMany).not.toHaveBeenCalled();
    expect(messages.sendText).not.toHaveBeenCalled();
  });
  it('does not deliver a target already claimed by another execution', async () => {
    const { sender, prisma, messages } = setup();
    expect((await sender.sendToTarget(campaign,{id:'target',lead_id:'lead'})).outcome).toBe('deferred');
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(messages.sendText).not.toHaveBeenCalled();
  });
  it.each([false, true])('rechecks customer replies after preparation (replied=%s)', async (replied) => {
    const current = { ...campaign, created_at: new Date('2026-09-22T12:00:00Z'), mode: 'template', template: 'Olá {nome}', respect_ai_block: true };
    const lead = { id:'lead', nome:'Cliente', telefone:'5511999999999', empresa:null, ai_blocked:false, last_customer_message_at:null, estagio_id:'stage', responsavel:null };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
      broadcast: { findFirst: jest.fn().mockResolvedValueOnce(current).mockResolvedValue(null), update: jest.fn() },
      broadcastTarget: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({count:1}) },
    };
    const prisma = {
      $transaction: (fn: (db: typeof tx)=>Promise<unknown>)=>fn(tx),
      lead: { findFirst: jest.fn().mockResolvedValueOnce(lead).mockResolvedValue({...lead,last_customer_message_at:replied?now:null}), count: jest.fn().mockResolvedValue(1) },
      user: { findFirst: jest.fn().mockResolvedValue({id:'manager',tenant_id:'t',role:'GERENTE',ativo:true}) },
      tenant: tx.tenant,
      broadcast: { findUnique: jest.fn().mockResolvedValue(current) },
      broadcastTarget: { findFirst: jest.fn().mockResolvedValue({id:'target'}), update: jest.fn(), updateMany: jest.fn() },
    };
    const messages = {sendText:jest.fn().mockResolvedValue({id:'message'})};
    const sender = new BroadcastSenderService(prisma as never,messages as never,{} as never);
    const result = await sender.sendToTarget(current as Broadcast,{id:'target',lead_id:'lead'});
    expect(result.outcome).toBe(replied?'skipped':'sent');
    expect(messages.sendText).toHaveBeenCalledTimes(replied?0:1);
    if (!replied) expect(messages.sendText).toHaveBeenCalledWith({lead_id:'lead',content:'Olá Cliente'},expect.objectContaining({tenantId:'t'}),{senderType:'system'});
  });
});
