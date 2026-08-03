import { BroadcastReplyService } from './broadcast-reply.service';

type Mock = ReturnType<typeof jest.fn>;

function makePrisma(targets: Array<{ id: string; status: string; broadcast_id: string }>) {
  return {
    broadcastTarget: {
      findMany: jest.fn().mockResolvedValue(targets),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('BroadcastReplyService.registerCustomerReply', () => {
  it('alvo já enviado vira replied', async () => {
    const prisma = makePrisma([{ id: 't1', status: 'sent', broadcast_id: 'b1' }]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r.replied).toBe(1);
    const call = (prisma.broadcastTarget.updateMany as Mock).mock.calls.find(
      ([arg]) => arg.data.status === 'replied',
    );
    expect(call).toBeDefined();
    expect(call![0].where.id.in).toEqual(['t1']);
    expect(call![0].data.replied_at).toBeInstanceOf(Date);
  });

  it('alvo ainda na fila vira skipped, NÃO replied', async () => {
    const prisma = makePrisma([{ id: 't2', status: 'pending', broadcast_id: 'b1' }]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r.skipped).toBe(1);
    expect(r.replied).toBe(0);
    const call = (prisma.broadcastTarget.updateMany as Mock).mock.calls.find(
      ([arg]) => arg.data.status === 'skipped',
    );
    expect(call![0].where.id.in).toEqual(['t2']);
    expect(call![0].data.error).toContain('cliente já estava conversando');
  });

  it('separa os dois grupos na mesma chamada', async () => {
    const prisma = makePrisma([
      { id: 't1', status: 'sent', broadcast_id: 'b1' },
      { id: 't2', status: 'pending', broadcast_id: 'b2' },
    ]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');
    expect(r).toEqual({ replied: 1, skipped: 1 });
  });

  it('lead sem alvo nenhum não escreve nada', async () => {
    const prisma = makePrisma([]);
    const svc = new BroadcastReplyService(prisma as never);
    const r = await svc.registerCustomerReply('lead-1');

    expect(r).toEqual({ replied: 0, skipped: 0 });
    expect(prisma.broadcastTarget.updateMany).not.toHaveBeenCalled();
  });

  it('só considera disparos running ou paused', async () => {
    const prisma = makePrisma([]);
    const svc = new BroadcastReplyService(prisma as never);
    await svc.registerCustomerReply('lead-1');

    const where = (prisma.broadcastTarget.findMany as Mock).mock.calls[0][0].where;
    expect(where.lead_id).toBe('lead-1');
    expect(where.status.in).toEqual(['pending', 'sent']);
    expect(where.broadcast.status.in).toEqual(['running', 'paused']);
  });
});
