import { CrmGateway } from './websocket.gateway';
import { Logger } from '@nestjs/common';

const tenant = 'a44772ed-1382-4400-84fc-3fa350e23e42';
const leadId = '11111111-1111-4111-8111-111111111111';
const user = { id: 'seller', tenant_id: tenant, role: 'OPERADOR', ativo: true, pl_sales_only: true };

function setup() {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ ...user }) },
    lead: { findFirst: jest.fn().mockResolvedValue({ id: leadId, tenant_id: tenant, responsavel_id: user.id, responsavel: { ...user } }) },
    task: { findFirst: jest.fn().mockResolvedValue({ lead_id: leadId }) },
  };
  const jwt = { verify: jest.fn().mockReturnValue({ sub: user.id, tenantId: tenant, plSalesOnly: false, role: 'SUPER_ADMIN' }) };
  const gateway = new CrmGateway(jwt as never, { get: () => 'secret' } as never, prisma as never);
  const delivered: Array<{ room: string; event: string; payload: unknown }> = [];
  const disconnectSockets = jest.fn();
  const server = { to: (room: string) => ({ emit: (event: string, payload: unknown) => delivered.push({ room, event, payload }) }), in: jest.fn(() => ({ disconnectSockets })), emit: (event: string, payload: unknown) => delivered.push({ room: 'ALL', event, payload }) };
  gateway.server = server as never;
  const client = { id: 'socket', handshake: { auth: { token: 'valid' }, headers: {} }, data: {} as Record<string, unknown>, join: jest.fn(), leave: jest.fn(), disconnect: jest.fn() };
  return { gateway, prisma, jwt, client, delivered, server, disconnectSockets };
}

describe('PL websocket isolation', () => {
  beforeAll(() => Logger.overrideLogger(false));
  it('notifies personal stage edits only to management tenant room and the owning seller room', () => {
    const m = setup();
    m.gateway.emitPipelineStagesChanged(tenant, 'pipeline', user.id);
    expect(m.delivered).toEqual([
      { room: `tenant:${tenant}`, event: 'pipeline:stages-changed', payload: { pipelineId: 'pipeline', ownerId: user.id } },
      { room: `user:${user.id}`, event: 'pipeline:stages-changed', payload: { pipelineId: 'pipeline', ownerId: user.id } },
    ]);
  });
  it('waits for database authentication when join arrives immediately on connect', async () => {
    const m = setup();
    let finish!: (value: typeof user) => void;
    m.prisma.user.findFirst.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const connecting = m.gateway.handleConnection(m.client as never);
    const joining = m.gateway.handleJoinLead(m.client as never, leadId);
    finish({ ...user, pl_sales_only: false });
    await connecting;
    expect(await joining).toEqual({ ok: true });
    expect(m.client.join).toHaveBeenCalledWith(`lead:${leadId}`);
  });
  it('reads current active user instead of trusting token role/flag', async () => {
    const m = setup(); await m.gateway.handleConnection(m.client as never);
    expect(m.prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: user.id, tenant_id: tenant, ativo: true } }));
    expect(m.client.join).toHaveBeenCalledWith('user:seller');
    expect(m.client.join).not.toHaveBeenCalledWith(`tenant:${tenant}`);
    expect(m.client.join).not.toHaveBeenCalledWith('access:unrestricted');
  });
  it.each([null, { ...user, ativo: false }, { ...user, tenant_id: 'other' }])('disconnects absent/inactive/cross-tenant database identity (%j)', async dbUser => {
    const m = setup(); m.prisma.user.findFirst.mockResolvedValue(dbUser);
    await m.gateway.handleConnection(m.client as never);
    expect(m.client.disconnect).toHaveBeenCalled();
    expect(m.client.join).not.toHaveBeenCalled();
  });
  it('disconnects on database failure or missing tenant', async () => {
    const m = setup(); m.prisma.user.findFirst.mockRejectedValue(new Error('offline'));
    await m.gateway.handleConnection(m.client as never);
    expect(m.client.disconnect).toHaveBeenCalled();
    const n = setup(); n.jwt.verify.mockReturnValue({ sub: user.id } as never);
    await n.gateway.handleConnection(n.client as never);
    expect(n.client.disconnect).toHaveBeenCalled();
  });
  it('allows own join acknowledgement without joining lead room and denies cross/reassigned', async () => {
    const m = setup(); await m.gateway.handleConnection(m.client as never);
    expect(await m.gateway.handleJoinLead(m.client as never, leadId)).toEqual({ ok: true });
    expect(m.client.join).not.toHaveBeenCalledWith(`lead:${leadId}`);
    m.prisma.lead.findFirst.mockResolvedValue(null);
    expect(await m.gateway.handleJoinLead(m.client as never, leadId)).toEqual({ ok: false });
  });
  it('denies joins before authentication and malformed lead IDs', async () => {
    const m = setup();
    expect(await m.gateway.handleJoinLead(m.client as never, leadId)).toEqual({ ok: false });
    await m.gateway.handleConnection(m.client as never);
    expect(await m.gateway.handleJoinLead(m.client as never, { id: leadId } as never)).toEqual({ ok: false });
    expect(await m.gateway.handleJoinLead(m.client as never, 'not-a-uuid')).toEqual({ ok: false });
  });
  it.each([{ ...user, pl_sales_only: false }, { ...user, role: 'GERENTE' }, { ...user, tenant_id: 'other' }])('keeps legacy tenant/lead rooms for unrestricted identity (%j)', async dbUser => {
    const m = setup(); m.prisma.user.findFirst.mockResolvedValue(dbUser); m.jwt.verify.mockReturnValue({ sub: user.id, tenantId: dbUser.tenant_id } as never);
    await m.gateway.handleConnection(m.client as never);
    await m.gateway.handleJoinLead(m.client as never, leadId);
    expect(m.client.join).toHaveBeenCalledWith(`tenant:${dbUser.tenant_id}`);
    expect(m.client.join).toHaveBeenCalledWith(`lead:${leadId}`);
  });
  it.each(['created', 'updated', 'stage', 'unread', 'message', 'status', 'media'])('sends %s privately only to the current restricted owner', async kind => {
    const m = setup();
    const emit = () => {
      switch (kind) {
        case 'created': return m.gateway.emitLeadCreated(leadId, {}, tenant);
        case 'updated': return m.gateway.emitLeadUpdated(leadId, { nome: 'Private' }, tenant);
        case 'stage': return m.gateway.emitLeadStageChanged(leadId, {}, tenant);
        case 'unread': return m.gateway.emitLeadUnreadReset(leadId, tenant);
        case 'message': return m.gateway.emitNewMessage(leadId, { content: 'Private' }, tenant);
        case 'status': return m.gateway.emitMessageStatusUpdate(leadId, 'message', 'READ');
        case 'media': return m.gateway.emitMessageMediaReady(leadId, { messageId: 'message', media_url: 'private-url' });
      }
    };
    await emit();
    expect(m.delivered.filter(x => x.room === 'user:seller').length).toBeGreaterThan(0);
    expect(m.delivered.some(x => x.room === 'ALL')).toBe(false);
    m.delivered.length = 0;
    m.prisma.lead.findFirst.mockResolvedValue({ id: leadId, tenant_id: tenant, responsavel_id: 'new-owner', responsavel: { ...user, id: 'new-owner' } });
    await emit();
    expect(m.delivered.some(x => x.room === 'user:seller')).toBe(false);
    expect(m.delivered.some(x => x.room === 'user:new-owner')).toBe(true);
  });
  it.each([null, { id: leadId, tenant_id: tenant, responsavel_id: null, responsavel: null }, { id: leadId, tenant_id: tenant, responsavel_id: user.id, responsavel: { ...user, pl_sales_only: false } }, { id: leadId, tenant_id: tenant, responsavel_id: user.id, responsavel: { ...user, ativo: false } }])('does not add private broadcasts for nonrestricted/missing owners', async lead => {
    const m = setup(); m.prisma.lead.findFirst.mockResolvedValue(lead);
    await m.gateway.emitNewMessage(leadId, {}, tenant);
    expect(m.delivered.some(x => x.room.startsWith('user:'))).toBe(false);
  });
  it('fails closed on delivery lookup error and avoids lookup for a known different tenant', async () => {
    const m = setup(); m.prisma.lead.findFirst.mockRejectedValue(new Error('offline'));
    await expect(m.gateway.emitNewMessage(leadId, {}, tenant)).resolves.toBeUndefined();
    expect(m.delivered.some(x => x.room.startsWith('user:'))).toBe(false);
    m.prisma.lead.findFirst.mockClear();
    await m.gateway.emitNewMessage(leadId, {}, 'other');
    expect(m.prisma.lead.findFirst).not.toHaveBeenCalled();
  });
  it('excludes restricted and unauthenticated sockets from legacy global broadcasts', async () => {
    const m = setup();
    m.gateway.emitInstanceStatusChanged('private-instance', 'open');
    expect(m.delivered).toEqual([{ room: 'access:unrestricted', event: 'instance:status-changed', payload: { instanceName: 'private-instance', status: 'open' } }]);
  });
  it('disconnects all user sessions through the adapter for profile changes', () => {
    const m = setup(); m.gateway.disconnectUser(user.id);
    expect(m.server.in).toHaveBeenCalledWith('user:seller');
    expect(m.disconnectSockets).toHaveBeenCalledWith(true);
  });
  it.each(['created', 'updated', 'overdue'])('suppresses task:%s when the lead is assigned away', async kind => {
    const m = setup();
    const task = { id: 'task', lead_id: leadId, tenant_id: tenant, responsavel_id: user.id, titulo: 'Private' };
    const emit = () => kind === 'created' ? m.gateway.emitTaskCreated(user.id, task) : kind === 'updated' ? m.gateway.emitTaskUpdated(user.id, task) : m.gateway.emitTaskOverdue(user.id, { taskId: 'task', titulo: 'Private', responsavel_id: user.id });
    await emit();
    expect(m.delivered.some(x => x.room === 'user:seller')).toBe(true);
    expect(m.prisma.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'task', tenant_id: tenant, responsavel_id: user.id, OR: [{ lead_id: null }, { lead: { tenant_id: tenant, responsavel_id: user.id } }] }) }));
    m.delivered.length = 0;
    m.prisma.task.findFirst.mockResolvedValue(null);
    await emit();
    expect(m.delivered).toEqual([]);
  });
  it('does not emit a stale task payload with a different linked lead', async () => {
    const m = setup(); m.prisma.task.findFirst.mockResolvedValue({ lead_id: 'new-lead' });
    await m.gateway.emitTaskUpdated(user.id, { id: 'task', tenant_id: tenant, lead_id: leadId });
    expect(m.delivered).toEqual([]);
  });
  it('preserves tasks for other tenants without a database lookup', async () => {
    const m = setup();
    await m.gateway.emitTaskCreated('other-seller', { id: 'task', tenant_id: 'other' });
    expect(m.delivered).toHaveLength(1);
    expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.task.findFirst).not.toHaveBeenCalled();
  });
  it('suppresses restricted tasks on database error', async () => {
    const m = setup(); m.prisma.task.findFirst.mockRejectedValue(new Error('offline'));
    await m.gateway.emitTaskCreated(user.id, { id: 'task', tenant_id: tenant, lead_id: leadId });
    expect(m.delivered).toEqual([]);
  });
  it('checks current owner before delivering stored or fresh conversation notifications', async () => {
    const m = setup(); const notification = { tenant_id: tenant, user_id: user.id, link: `/chat/${leadId}`, conteudo: 'Private' };
    await m.gateway.emitNotification(user.id, notification);
    expect(m.delivered).toHaveLength(1);
    expect(m.prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: leadId, tenant_id: tenant, responsavel_id: user.id } }));
    m.delivered.length = 0; m.prisma.lead.findFirst.mockResolvedValue(null);
    await m.gateway.emitNotification(user.id, notification);
    expect(m.delivered).toEqual([]);
  });
  it.each([undefined, '/partners', '/chat/not-a-uuid', `/chat/${leadId}/unexpected`])('denies unknown restricted notification links (%s)', async link => {
    const m = setup(); await m.gateway.emitNotification(user.id, { tenant_id: tenant, link });
    expect(m.delivered).toEqual([]);
  });
  it('preserves existing nonrestricted user notifications and fails closed for lookup failure', async () => {
    const m = setup(); m.prisma.user.findFirst.mockResolvedValue({ ...user, pl_sales_only: false });
    await m.gateway.emitNotification(user.id, { tenant_id: tenant, link: '/partners' });
    expect(m.delivered).toHaveLength(1);
    m.delivered.length = 0; m.prisma.user.findFirst.mockRejectedValue(new Error('offline'));
    await m.gateway.emitNotification(user.id, { tenant_id: tenant, link: `/chat/${leadId}` });
    expect(m.delivered).toEqual([]);
  });
});
