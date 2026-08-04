import { classifyBroadcastError, aggregateFailureReasons, BROADCAST_ERROR_LABEL } from './broadcast-error';

describe('classifyBroadcastError', () => {
  it('instância desconectada', () => {
    expect(classifyBroadcastError(new Error('Sua instância WhatsApp não está conectada'))).toBe(
      'instancia_desconectada',
    );
  });

  it('token do provedor ausente é problema de instância, não do lead', () => {
    expect(classifyBroadcastError(new Error('Token UazAPI ausente para a instancia'))).toBe(
      'instancia_desconectada',
    );
  });

  it('configuração de IA', () => {
    expect(classifyBroadcastError(new Error('Nenhum modelo de IA configurado'))).toBe('ia_sem_modelo');
    expect(classifyBroadcastError(new Error('Modelo de IA não encontrado'))).toBe('ia_sem_modelo');
  });

  it('erro HTTP do provedor vira um código só, com ou sem id no texto', () => {
    // O ponto do código: duas falhas do mesmo tipo têm que cair no mesmo balde
    // mesmo com url, id e timestamp diferentes no texto.
    const a = { response: { status: 502 }, message: 'Request failed https://api.uazapi.com/send/text?id=abc123' };
    const b = { response: { status: 502 }, message: 'Request failed https://api.uazapi.com/send/text?id=zzz999' };
    expect(classifyBroadcastError(a)).toBe('provedor_recusou');
    expect(classifyBroadcastError(b)).toBe(classifyBroadcastError(a));
  });

  it('erro de rede', () => {
    expect(classifyBroadcastError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe('rede');
    expect(classifyBroadcastError({ code: 'ETIMEDOUT', message: 'timeout' })).toBe('rede');
  });

  it('o que não dá para reconhecer não é forçado num balde errado', () => {
    expect(classifyBroadcastError(new Error('boom qualquer'))).toBe('outro');
    expect(classifyBroadcastError(undefined)).toBe('outro');
  });

  it('todo código tem rótulo em português', () => {
    const codigos = Object.keys(BROADCAST_ERROR_LABEL);
    expect(codigos.length).toBeGreaterThan(0);
    for (const c of codigos) expect(BROADCAST_ERROR_LABEL[c as never]).toMatch(/\S/);
  });
});

describe('aggregateFailureReasons', () => {
  it('agrupa pelo rótulo do código', () => {
    const r = aggregateFailureReasons([
      { error_code: 'instancia_desconectada', error: 'texto antigo x', _count: 3 },
      { error_code: 'instancia_desconectada', error: 'texto antigo y', _count: 2 },
    ]);
    expect(r).toEqual({ [BROADCAST_ERROR_LABEL.instancia_desconectada]: 5 });
  });

  it('linha antiga sem código cai no texto livre, cortado', () => {
    // Alvos gravados antes desta mudança não têm code — some-los em "Outros"
    // apagaria a única pista que existe sobre falhas passadas.
    const longo = 'x'.repeat(200);
    const r = aggregateFailureReasons([{ error_code: null, error: longo, _count: 1 }]);
    const chave = Object.keys(r)[0];
    expect(chave).toHaveLength(120);
    expect(r[chave]).toBe(1);
  });

  it('sem código e sem texto não vira chave vazia', () => {
    const r = aggregateFailureReasons([{ error_code: null, error: null, _count: 2 }]);
    expect(r).toEqual({ 'Motivo não registrado': 2 });
  });

  it('mantém no máximo 5 motivos e soma o resto', () => {
    const linhas = Array.from({ length: 8 }, (_, i) => ({
      error_code: null,
      error: `motivo ${i}`,
      _count: 8 - i,
    }));
    const r = aggregateFailureReasons(linhas);
    expect(Object.keys(r)).toHaveLength(6);
    expect(r['Outros motivos']).toBe(3 + 2 + 1); // os três menores
  });
});
