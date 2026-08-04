import { BroadcastDispatcher } from './broadcast.dispatcher';

const TENANT = {
  id: 'tenant-1',
  broadcast_window_start: 9,
  broadcast_window_end: 18,
  broadcast_window_days: [1, 2, 3, 4, 5],
};

const BROADCAST = {
  id: 'b1',
  tenant_id: 'tenant-1',
  status: 'running',
  throttle_seconds: 900,
  daily_limit: 30,
  last_dispatch_at: null,
};

function makeDeps(nowUtc: string, tenants: unknown[] = [TENANT]) {
  const prisma = {
    broadcast: {
      findMany: jest.fn().mockResolvedValue([BROADCAST]),
      update: jest.fn().mockResolvedValue({}),
    },
    tenant: { findMany: jest.fn().mockResolvedValue(tenants) },
    broadcastTarget: {
      findFirst: jest.fn().mockResolvedValue({ id: 't1', created_at: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sender = { sentToday: jest.fn().mockResolvedValue(0), sendToTarget: jest.fn().mockResolvedValue(undefined) };
  const d = new BroadcastDispatcher(prisma as never, sender as never);
  // Fake timers em vez de espionar `global.Date`: o spy substitui o construtor
  // inteiro e leva junto os estáticos — `Date.now` virava undefined e qualquer
  // logger do Nest quebrava com "Date.now is not a function".
  jest.useFakeTimers().setSystemTime(new Date(nowUtc));
  return { d, prisma, sender };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('BroadcastDispatcher — janela de horário', () => {
  it('dentro da janela, despacha', async () => {
    // 2026-08-03 é segunda. 17:00Z = 14:00 BRT.
    const { d, sender } = makeDeps('2026-08-03T17:00:00Z');
    await d.tick();
    expect(sender.sendToTarget).toHaveBeenCalled();
  });

  it('fora da janela, NÃO despacha', async () => {
    // 03:00Z = 00:00 BRT.
    const { d, sender } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    expect(sender.sendToTarget).not.toHaveBeenCalled();
  });

  it('fora da janela, NÃO marca o alvo como falha', async () => {
    const { d, prisma } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    expect(prisma.broadcastTarget.update).not.toHaveBeenCalled();
  });

  it('falha do envio grava o motivo em código, não só o texto cru', async () => {
    const { d, prisma, sender } = makeDeps('2026-08-03T17:00:00Z');
    sender.sendToTarget.mockRejectedValue(new Error('Sua instância WhatsApp não está conectada'));
    await d.tick();

    const falha = (prisma.broadcastTarget.update as jest.Mock).mock.calls.find(
      ([arg]) => arg.data?.status === 'failed',
    );
    expect(falha![0].data.error_code).toBe('instancia_desconectada');
    expect(falha![0].data.error).toContain('não está conectada');
  });

  it('tenant sem janela conhecida, NÃO despacha', async () => {
    // Falha FECHADA: se a linha do tenant não veio, o guarda que impede
    // mensagem às 3h da manhã simplesmente não existiria — o custo de esperar
    // um tick é nada perto do custo de o número ser denunciado.
    const { d, sender } = makeDeps('2026-08-03T17:00:00Z', []);
    await d.tick();
    expect(sender.sendToTarget).not.toHaveBeenCalled();
  });

  it('fora da janela, NÃO consome a janela de throttle', async () => {
    const { d, prisma } = makeDeps('2026-08-04T03:00:00Z');
    await d.tick();
    const consumiu = (prisma.broadcast.update as jest.Mock).mock.calls.some(
      ([arg]) => arg.data?.last_dispatch_at !== undefined,
    );
    expect(consumiu).toBe(false);
  });
});
