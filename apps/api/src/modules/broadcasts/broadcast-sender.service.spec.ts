import { BroadcastSenderService, startOfDayBrt } from './broadcast-sender.service';

/**
 * Prisma falso que APLICA o filtro em memória, em vez de só devolver um número
 * fixo — asserir o formato do `where` provaria só que o objeto tem a forma que
 * eu escrevi, não que a contagem está certa.
 */
type Row = { status: string; sent_at: Date | null };
function fakeCount(rows: Row[]) {
  return ({ where }: { where: { status: string | { in: string[] }; sent_at?: { gte: Date } } }) => {
    const statusOk = (s: string) =>
      typeof where.status === 'string' ? where.status === s : where.status.in.includes(s);
    return Promise.resolve(
      rows.filter((r) => statusOk(r.status) && (!where.sent_at || (r.sent_at ? r.sent_at >= where.sent_at.gte : false)))
        .length,
    );
  };
}

function makeSender(rows: Row[]) {
  const prisma = { broadcastTarget: { count: jest.fn(fakeCount(rows)) } };
  return new BroadcastSenderService(prisma as never, {} as never, {} as never);
}

describe('BroadcastSenderService.sentToday — limite diário', () => {
  const hoje = new Date(startOfDayBrt().getTime() + 3600_000);
  const ontem = new Date(startOfDayBrt().getTime() - 3600_000);

  it('conta o alvo que recebeu hoje e depois RESPONDEU', async () => {
    // O alvo virou 'replied' pelo gancho de resposta, mas a mensagem saiu hoje:
    // se ele sumir da conta, o disparo estoura o daily_limit — justamente a
    // trava que protege o número de ser denunciado.
    const sender = makeSender([
      { status: 'sent', sent_at: hoje },
      { status: 'replied', sent_at: hoje },
    ]);
    expect(await sender.sentToday('b1')).toBe(2);
  });

  it('não conta alvo enviado ontem', async () => {
    const sender = makeSender([
      { status: 'sent', sent_at: ontem },
      { status: 'replied', sent_at: ontem },
      { status: 'sent', sent_at: hoje },
    ]);
    expect(await sender.sentToday('b1')).toBe(1);
  });

  it('não conta pendente, pulado nem falhado', async () => {
    const sender = makeSender([
      { status: 'pending', sent_at: null },
      { status: 'skipped', sent_at: null },
      { status: 'failed', sent_at: hoje },
      { status: 'sent', sent_at: hoje },
    ]);
    expect(await sender.sentToday('b1')).toBe(1);
  });
});
