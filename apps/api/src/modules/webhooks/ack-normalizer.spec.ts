import { extractAck, normalizeAckUpdates } from './ack-normalizer';

describe('normalizeAckUpdates', () => {
  it('array Baileys antigo passa direto', () => {
    const arr = [{ key: { id: 'a' } }, { key: { id: 'b' } }];
    expect(normalizeAckUpdates(arr)).toBe(arr);
  });

  it('objeto flat Evolution v2 vira array de 1 (bug que prendia outbound em SENT)', () => {
    const flat = { keyId: 'x', status: 'DELIVERY_ACK' };
    expect(normalizeAckUpdates(flat)).toEqual([flat]);
  });

  it('null/undefined/primitivo vira lista vazia', () => {
    expect(normalizeAckUpdates(null)).toEqual([]);
    expect(normalizeAckUpdates(undefined)).toEqual([]);
    expect(normalizeAckUpdates('str')).toEqual([]);
    expect(normalizeAckUpdates(42)).toEqual([]);
  });
});

describe('extractAck', () => {
  it('shape Baileys: key.id + update.status', () => {
    expect(
      extractAck({ key: { id: 'MSG1' }, update: { status: 'DELIVERY_ACK' } }),
    ).toEqual({ messageId: 'MSG1', status: 'DELIVERED' });
  });

  it('shape Evolution v2 flat: keyId + status', () => {
    expect(extractAck({ keyId: 'MSG2', status: 'READ' })).toEqual({
      messageId: 'MSG2',
      status: 'READ',
    });
  });

  it('PLAYED mapeia pra READ (áudio ouvido)', () => {
    expect(extractAck({ keyId: 'M', status: 'PLAYED' })).toEqual({
      messageId: 'M',
      status: 'READ',
    });
  });

  it('ERROR mapeia pra FAILED', () => {
    expect(extractAck({ keyId: 'M', status: 'ERROR' })).toEqual({
      messageId: 'M',
      status: 'FAILED',
    });
  });

  it('status não mapeado (PENDING/SERVER_ACK) retorna null', () => {
    expect(extractAck({ keyId: 'M', status: 'PENDING' })).toBeNull();
    expect(extractAck({ keyId: 'M', status: 'SERVER_ACK' })).toBeNull();
  });

  it('sem id ou sem status retorna null', () => {
    expect(extractAck({ status: 'READ' })).toBeNull();
    expect(extractAck({ keyId: 'M' })).toBeNull();
    expect(extractAck({})).toBeNull();
  });

  it('key.id tem precedência sobre keyId', () => {
    expect(
      extractAck({ key: { id: 'REAL' }, keyId: 'FALLBACK', status: 'READ' }),
    ).toEqual({ messageId: 'REAL', status: 'READ' });
  });
});
