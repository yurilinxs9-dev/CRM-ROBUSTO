import { parseServerMessages, planReconciliation, ServerMessage } from './status-reconciler';

const NOW = Date.parse('2026-07-15T18:00:00Z');
const HOUR = 3600_000;

function sv(partial: Partial<ServerMessage>): ServerMessage {
  return { messageid: 'X', fromMe: true, status: 'Sent', messageTimestamp: NOW - HOUR, ...partial };
}

describe('parseServerMessages', () => {
  it('extrai campos do shape do /message/find e ignora itens sem messageid', () => {
    const raw = {
      messages: [
        { messageid: 'A1', fromMe: true, status: 'Delivered', messageTimestamp: 123 },
        { fromMe: false, status: 'Read' },
        'lixo',
      ],
    };
    expect(parseServerMessages(raw)).toEqual([
      { messageid: 'A1', fromMe: true, status: 'Delivered', messageTimestamp: 123 },
    ]);
  });

  it('retorna vazio para payloads sem messages', () => {
    expect(parseServerMessages(null)).toEqual([]);
    expect(parseServerMessages({})).toEqual([]);
  });
});

describe('planReconciliation', () => {
  const opts = { now: NOW, stuckAfterMs: 30 * 60_000 };

  it('mapeia Delivered/Read/Played do servidor', () => {
    const db = [
      { id: 'm1', wamid: 'W1', createdAt: new Date(NOW - HOUR) },
      { id: 'm2', wamid: 'W2', createdAt: new Date(NOW - HOUR) },
      { id: 'm3', wamid: 'W3', createdAt: new Date(NOW - HOUR) },
    ];
    const server = [
      sv({ messageid: 'W1', status: 'Delivered' }),
      sv({ messageid: 'W2', status: 'Read' }),
      sv({ messageid: 'W3', status: 'Played' }),
    ];
    expect(planReconciliation(db, server, opts)).toEqual([
      { id: 'm1', action: 'DELIVERED' },
      { id: 'm2', action: 'READ' },
      { id: 'm3', action: 'READ' },
    ]);
  });

  it('marca STUCK quando msg posterior fromMe já entregou (caso Ivana)', () => {
    const db = [{ id: 'm1', wamid: 'W1', createdAt: new Date(NOW - 5 * HOUR) }];
    const server = [
      sv({ messageid: 'W1', status: 'Sent', messageTimestamp: NOW - 5 * HOUR }),
      sv({ messageid: 'W9', status: 'Delivered', messageTimestamp: NOW - HOUR }),
    ];
    expect(planReconciliation(db, server, opts)).toEqual([{ id: 'm1', action: 'STUCK' }]);
  });

  it('NÃO marca STUCK sem prova de entrega posterior (destinatário offline)', () => {
    const db = [{ id: 'm1', wamid: 'W1', createdAt: new Date(NOW - 5 * HOUR) }];
    const server = [
      sv({ messageid: 'W1', status: 'Sent', messageTimestamp: NOW - 5 * HOUR }),
      // inbound Read não conta como prova (é recibo NOSSO, não do destinatário)
      sv({ messageid: 'W2', fromMe: false, status: 'Read', messageTimestamp: NOW - HOUR }),
      // fromMe posterior mas também ainda Sent
      sv({ messageid: 'W3', status: 'Sent', messageTimestamp: NOW - HOUR }),
    ];
    expect(planReconciliation(db, server, opts)).toEqual([]);
  });

  it('NÃO marca STUCK antes de stuckAfterMs', () => {
    const db = [{ id: 'm1', wamid: 'W1', createdAt: new Date(NOW - 10 * 60_000) }];
    const server = [
      sv({ messageid: 'W1', status: 'Sent', messageTimestamp: NOW - 10 * 60_000 }),
      sv({ messageid: 'W9', status: 'Delivered', messageTimestamp: NOW - 5 * 60_000 }),
    ];
    expect(planReconciliation(db, server, opts)).toEqual([]);
  });

  it('entrega posterior tem que ser POSTERIOR — anterior não prova nada', () => {
    const db = [{ id: 'm1', wamid: 'W1', createdAt: new Date(NOW - 2 * HOUR) }];
    const server = [
      sv({ messageid: 'W0', status: 'Delivered', messageTimestamp: NOW - 5 * HOUR }),
      sv({ messageid: 'W1', status: 'Sent', messageTimestamp: NOW - 2 * HOUR }),
    ];
    expect(planReconciliation(db, server, opts)).toEqual([]);
  });

  it('ignora mensagens não encontradas no servidor', () => {
    const db = [{ id: 'm1', wamid: 'W-nao-existe', createdAt: new Date(NOW - HOUR) }];
    expect(planReconciliation(db, [sv({ messageid: 'W2', status: 'Delivered' })], opts)).toEqual([]);
  });
});
