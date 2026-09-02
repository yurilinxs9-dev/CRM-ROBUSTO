import { buildMessageScope, isSupervising } from './lead-message-scope';
import type { MessageScopeCtx, MessageScopeLead } from './lead-message-scope';

const lead = (over: Partial<MessageScopeLead> = {}): MessageScopeLead => ({
  responsavel_id: 'u-dono',
  instancia_whatsapp: 'inst-A',
  assumed_at: null,
  is_private: false,
  ...over,
});

const ctx = (over: Partial<MessageScopeCtx> = {}): MessageScopeCtx => ({
  userId: 'u-dono',
  role: 'OPERADOR',
  focusMode: false,
  shareHistoryEnabled: false,
  poolEnabled: false,
  ownConversationIds: ['conv-1'],
  ownedInstances: ['inst-A'],
  ...over,
});

describe('isSupervising', () => {
  it('gerente sem foco supervisiona', () => {
    expect(isSupervising(lead(), 'GERENTE', false)).toBe(true);
  });
  it('gerente em foco NAO supervisiona lead com dono', () => {
    expect(isSupervising(lead(), 'GERENTE', true)).toBe(false);
  });
  it('gerente em foco supervisiona lead sem dono', () => {
    expect(isSupervising(lead({ responsavel_id: null }), 'GERENTE', true)).toBe(true);
  });
  it('operador nunca supervisiona', () => {
    expect(isSupervising(lead(), 'OPERADOR', false)).toBe(false);
  });
});

describe('buildMessageScope', () => {
  it('lead privado de outro devolve null', () => {
    expect(buildMessageScope(lead({ is_private: true }), ctx({ userId: 'u-outro' }))).toBeNull();
  });
  it('gerente supervisionando: sem corte ({}), mesmo com assumed_at', () => {
    expect(
      buildMessageScope(lead({ assumed_at: new Date('2026-01-01') }), ctx({ role: 'GERENTE' })),
    ).toEqual({});
  });
  it('operador sem conversa, sem ser dono e sem a instancia devolve null', () => {
    expect(
      buildMessageScope(
        lead({ responsavel_id: 'u-x', instancia_whatsapp: 'inst-Z' }),
        ctx({ ownConversationIds: [], ownedInstances: ['inst-A'] }),
      ),
    ).toBeNull();
  });
  it('dono no modo individual recebe corte por conversa', () => {
    const where = buildMessageScope(lead(), ctx());
    expect(where?.AND).toEqual([
      {
        OR: [
          { conversation_id: { in: ['conv-1'] } },
          { conversation_id: null, instance_name: { in: ['inst-A'] } },
        ],
      },
    ]);
  });
  it('dono com pool ligado nao tem corte por conversa', () => {
    expect(buildMessageScope(lead(), ctx({ poolEnabled: true }))).toEqual({});
  });
  it('operador com assumed_at e sem share_history recebe corte de historico', () => {
    const assumed = new Date('2026-08-01T00:00:00Z');
    const where = buildMessageScope(lead({ assumed_at: assumed }), ctx());
    expect(where?.AND).toContainEqual({
      OR: [{ created_at: { gte: assumed } }, { visible_to_user_id: 'u-dono' }],
    });
  });
  it('share_history_enabled desliga o corte de historico', () => {
    const where = buildMessageScope(
      lead({ assumed_at: new Date('2026-08-01') }),
      ctx({ shareHistoryEnabled: true }),
    );
    expect(where?.AND).toHaveLength(1);
  });
});
