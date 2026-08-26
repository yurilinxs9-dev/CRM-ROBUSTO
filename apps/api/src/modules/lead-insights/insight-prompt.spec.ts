import type { InsightContexto } from './insight-prompt';
import { extrairInsight, mesclarMemoria, montarPromptInsight } from './insight-prompt';

describe('extrairInsight', () => {
  const valido = JSON.stringify({
    resumo: 'Cliente pediu prazo de entrega.',
    memoria_novos_fatos: [{ fato: 'aniversário do filho dia 22', quando_dito: '2026-08-20' }],
    proxima_acao_em_dias: 3,
    proxima_acao_motivo: 'ficou de confirmar metragem',
    msg_sugerida: 'Oi! Conseguiu conferir a metragem?',
  });

  it('JSON limpo passa', () => {
    const r = extrairInsight(valido);
    expect(r?.resumo).toContain('prazo');
    expect(r?.proxima_acao_em_dias).toBe(3);
  });

  it('JSON embrulhado em texto/markdown e extraido', () => {
    expect(extrairInsight('Claro! Aqui está:\n```json\n' + valido + '\n```\nEspero ter ajudado.')).not.toBeNull();
  });

  it('dias fora do dominio clampa 1..30; nao-numero vira 7 (default)', () => {
    const base = JSON.parse(valido);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 90 }))?.proxima_acao_em_dias).toBe(30);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 0 }))?.proxima_acao_em_dias).toBe(1);
    expect(extrairInsight(JSON.stringify({ ...base, proxima_acao_em_dias: 'logo' }))?.proxima_acao_em_dias).toBe(7);
  });

  it('campos texto truncados (resumo 800, motivo 200, msg 500) e strings coeridas', () => {
    const base = JSON.parse(valido);
    const r = extrairInsight(JSON.stringify({ ...base, resumo: 'x'.repeat(2000), msg_sugerida: 42 }));
    expect(r?.resumo.length).toBe(800);
    expect(r?.msg_sugerida).toBe(''); // nao-string vira vazio, nao derruba
  });

  it('memoria suja: itens nao-objeto/fato vazio somem', () => {
    const base = JSON.parse(valido);
    const r = extrairInsight(JSON.stringify({ ...base, memoria_novos_fatos: [42, { fato: '' }, { fato: 'obra nova' }] }));
    expect(r?.memoria_novos_fatos).toEqual([{ fato: 'obra nova', quando_dito: '' }]);
  });

  it('sem JSON algum -> null', () => {
    expect(extrairInsight('nao sei responder')).toBeNull();
  });

  it('JSON aninhado seguido de prosa com } solta e recuperado', () => {
    const texto = valido + '\nObs: se quiser, e so fechar com } no final.';
    const r = extrairInsight(texto);
    expect(r?.proxima_acao_em_dias).toBe(3);
    expect(r?.memoria_novos_fatos).toHaveLength(1);
  });

  it('entrada vazia ou ausente nao lanca e devolve null', () => {
    expect(extrairInsight('')).toBeNull();
    expect(extrairInsight('   \n ')).toBeNull();
    expect(extrairInsight(undefined as unknown as string)).toBeNull();
  });

  it('objeto de ruido antes do real e descartado; vence o candidato com as chaves', () => {
    const r = extrairInsight('{"thinking":"vou analisar a conversa"}\n' + valido);
    expect(r?.resumo).toContain('prazo');
    expect(r?.proxima_acao_em_dias).toBe(3);
    // preambulo com chaves soltas antes do JSON real tambem e recuperado
    const r2 = extrairInsight('Segue {conforme pedido}: ' + valido);
    expect(r2?.resumo).toContain('prazo');
  });

  it('objeto sem nenhuma das 5 chaves -> null (nao vira insight vazio)', () => {
    expect(extrairInsight('{"thinking":"nao consegui"}')).toBeNull();
    expect(extrairInsight('blz: {"ok":true, "detalhe":{"x":1}} fim')).toBeNull();
  });

  it('truncagem nao parte par substituto (emoji na fronteira)', () => {
    const base = JSON.parse(valido);
    const r = extrairInsight(JSON.stringify({ ...base, resumo: 'a'.repeat(799) + '😀fim' }));
    expect(r?.resumo.length).toBe(799);
    expect(/[\uD800-\uDBFF]$/.test(r?.resumo ?? '')).toBe(false);
  });
});

describe('mesclarMemoria', () => {
  it('dedupe por fato normalizado (caixa/acentos), mantem ordem, cap 30', () => {
    const atual = [{ fato: 'Obra no Niterói', quando_dito: '2026-08-01' }];
    const novos = [{ fato: 'obra no niteroi', quando_dito: '2026-08-20' }, { fato: 'gripe', quando_dito: '2026-08-20' }];
    const r = mesclarMemoria(atual, novos);
    expect(r).toHaveLength(2);
    expect(r[0].quando_dito).toBe('2026-08-01'); // primeiro registro vence
  });
});

/** Contexto minimo reutilizavel nos testes de prompt. */
function ctxMinimo(): InsightContexto {
  return {
    lead: {
      nome: 'Ana',
      telefone: '55999',
      etapa: 'Consulta',
      temperatura: 'MORNO',
      valor_estimado: 1500,
      ultima_interacao: new Date('2026-08-20'),
      etapas_disponiveis: [],
    },
    insightAnterior: { resumo: 'antigo', memoria: [{ fato: 'gripe', quando_dito: '2026-08-10' }] },
    mensagens: [{ de: 'cliente', texto: 'quero orçamento', em: new Date('2026-08-20') }],
  };
}

describe('nota do atendimento e ultima compra', () => {
  const base = {
    resumo: 'Cliente pediu prazo.',
    memoria_novos_fatos: [],
    proxima_acao_em_dias: 3,
    proxima_acao_motivo: 'confirmar metragem',
    msg_sugerida: 'Oi!',
  };

  it('nota valida e compra citada passam sanitizados', () => {
    const r = extrairInsight(JSON.stringify({
      ...base,
      nota_atendimento: 8.5,
      nota_ponto_forte: 'respondeu rápido',
      nota_ponto_melhoria: 'não confirmou o prazo',
      ultima_compra: { descricao: 'treliça e vergalhão', valor: 4200, quando: 'mês passado' },
    }));
    expect(r?.nota_atendimento).toBe(9); // round de 8.5
    expect(r?.nota_ponto_forte).toBe('respondeu rápido');
    expect(r?.ultima_compra).toEqual({ descricao: 'treliça e vergalhão', valor: 4200, quando: 'mês passado' });
  });

  it('nota fora do dominio vira null; compra suja vira null; valor negativo vira null dentro da compra', () => {
    const r1 = extrairInsight(JSON.stringify({ ...base, nota_atendimento: 'otima' }));
    expect(r1?.nota_atendimento).toBeNull();
    const r2 = extrairInsight(JSON.stringify({ ...base, nota_atendimento: 15, ultima_compra: 'comprou algo' }));
    expect(r2?.nota_atendimento).toBe(10); // clamp
    expect(r2?.ultima_compra).toBeNull();
    const r3 = extrairInsight(JSON.stringify({ ...base, ultima_compra: { descricao: 'cimento', valor: -5, quando: 42 } }));
    expect(r3?.ultima_compra).toEqual({ descricao: 'cimento', valor: null, quando: '' });
  });

  it('campos ausentes: nota null, compra null, textos vazios (retrocompat)', () => {
    const r = extrairInsight(JSON.stringify(base));
    expect(r?.nota_atendimento).toBeNull();
    expect(r?.ultima_compra).toBeNull();
    expect(r?.nota_ponto_forte).toBe('');
  });

  it('prompt pede as chaves novas e as regras (avaliar o atendente; nunca inventar compra)', () => {
    const msgs = montarPromptInsight(ctxMinimo());
    expect(msgs[0].content).toMatch(/nota_atendimento/);
    expect(msgs[0].content).toMatch(/ultima_compra/);
    expect(msgs[0].content).toMatch(/atendente/i);
    expect(msgs[0].content).toMatch(/[nN]unca invente/);
  });

  it('shape do prompt mostra ultima_compra como null (nao ensina a copiar compra falsa)', () => {
    const shape = montarPromptInsight(ctxMinimo())[0].content.split('Regras de cada campo')[0];
    expect(shape).toMatch(/"ultima_compra":\s*null/);
    expect(shape).not.toMatch(/"descricao"/); // exemplo preenchido so na regra textual, nunca no shape
  });

  it('fragmento nota-only nao rouba o candidato: vence o objeto com resumo', () => {
    const completo = JSON.stringify({ ...base, nota_atendimento: 6 });
    const r = extrairInsight('{"nota_atendimento": 8}\n' + completo);
    expect(r?.resumo).toContain('prazo');
    expect(r?.nota_atendimento).toBe(6);
  });

  it('numero em pt-BR com virgula decimal e aceito', () => {
    const r = extrairInsight(JSON.stringify({
      ...base,
      nota_atendimento: '8,5',
      ultima_compra: { descricao: 'cimento', valor: '4200,50', quando: '' },
    }));
    expect(r?.nota_atendimento).toBe(9);
    expect(r?.ultima_compra?.valor).toBe(4200.5);
  });
});

describe('sugestao de temperatura e etapa', () => {
  /** Contrato antigo (9 chaves), usado como base para acrescentar as 4 novas. */
  const base9 = {
    resumo: 'Cliente pediu prazo.',
    memoria_novos_fatos: [],
    proxima_acao_em_dias: 3,
    proxima_acao_motivo: 'confirmar metragem',
    msg_sugerida: 'Oi!',
    nota_atendimento: 8,
    nota_ponto_forte: 'respondeu rápido',
    nota_ponto_melhoria: 'não confirmou o prazo',
    ultima_compra: null,
  };

  it('resposta com as 13 chaves: temperatura valida passa e justificativa trunca em 200', () => {
    const r = extrairInsight(JSON.stringify({
      ...base9,
      temperatura_sugerida: 'QUENTE',
      temperatura_justificativa: 'j'.repeat(500),
      etapa_sugerida: null,
      etapa_sugerida_motivo: '',
    }));
    expect(r?.temperatura_sugerida).toBe('QUENTE');
    expect(r?.temperatura_justificativa.length).toBe(200);
  });

  it('temperatura aceita minuscula e com espaco no lugar do underscore', () => {
    const comMinuscula = extrairInsight(JSON.stringify({ ...base9, temperatura_sugerida: '  quente ' }));
    expect(comMinuscula?.temperatura_sugerida).toBe('QUENTE');
    const comEspaco = extrairInsight(JSON.stringify({ ...base9, temperatura_sugerida: 'muito quente' }));
    expect(comEspaco?.temperatura_sugerida).toBe('MUITO_QUENTE');
    const canonica = extrairInsight(JSON.stringify({ ...base9, temperatura_sugerida: 'MUITO_QUENTE' }));
    expect(canonica?.temperatura_sugerida).toBe('MUITO_QUENTE');
  });

  it('temperatura lixo vira null e derruba a justificativa (justificativa so vale acompanhada)', () => {
    for (const lixo of ['MUITO QUENTE!!', 7, '', 'MORNINHO', null, { t: 'QUENTE' }]) {
      const r = extrairInsight(JSON.stringify({
        ...base9,
        temperatura_sugerida: lixo,
        temperatura_justificativa: 'cliente pediu orçamento',
      }));
      expect(r?.temperatura_sugerida).toBeNull();
      expect(r?.temperatura_justificativa).toBe('');
    }
  });

  it('etapa_sugerida: string util trunca em 60; vazia/numero vira null e derruba o motivo', () => {
    const ok = extrairInsight(JSON.stringify({
      ...base9,
      etapa_sugerida: 'e'.repeat(120),
      etapa_sugerida_motivo: 'm'.repeat(500),
    }));
    expect(ok?.etapa_sugerida?.length).toBe(60);
    expect(ok?.etapa_sugerida_motivo.length).toBe(200);

    for (const lixo of ['', '   ', 42, null, ['Proposta']]) {
      const r = extrairInsight(JSON.stringify({
        ...base9,
        etapa_sugerida: lixo,
        etapa_sugerida_motivo: 'proposta enviada',
      }));
      expect(r?.etapa_sugerida).toBeNull();
      expect(r?.etapa_sugerida_motivo).toBe('');
    }
  });

  it('resposta no contrato antigo (9 chaves) segue valida: campos novos null/vazio', () => {
    const r = extrairInsight(JSON.stringify(base9));
    expect(r?.resumo).toContain('prazo');
    expect(r?.temperatura_sugerida).toBeNull();
    expect(r?.temperatura_justificativa).toBe('');
    expect(r?.etapa_sugerida).toBeNull();
    expect(r?.etapa_sugerida_motivo).toBe('');
  });

  it('prompt lista as etapas disponiveis para sugestao', () => {
    const ctx = ctxMinimo();
    ctx.lead.etapas_disponiveis = ['Proposta', 'Negociação'];
    const user = montarPromptInsight(ctx)[1].content;
    expect(user).toMatch(/Etapas disponíveis para sugestão \(etapa atual: Consulta\)/);
    expect(user).toContain('- Proposta');
    expect(user).toContain('- Negociação');
  });

  it('sem etapas disponiveis o prompt manda devolver etapa_sugerida null', () => {
    const user = montarPromptInsight(ctxMinimo())[1].content;
    expect(user).toContain('Nenhuma etapa disponível: devolva etapa_sugerida null.');
    expect(user).not.toMatch(/Etapas disponíveis para sugestão/);
  });

  it('system pede as chaves do contrato atual e explica as regras novas', () => {
    const system = montarPromptInsight(ctxMinimo())[0].content;
    expect(system).toMatch(/14 chaves/);
    expect(system).not.toMatch(/(9|13) chaves/);
    expect(system).toMatch(/temperatura_sugerida/);
    expect(system).toMatch(/temperatura_justificativa/);
    expect(system).toMatch(/etapa_sugerida/);
    expect(system).toMatch(/etapa_sugerida_motivo/);
    expect(system).toMatch(/MUITO_QUENTE/);
    const user = montarPromptInsight(ctxMinimo())[1].content;
    expect(user).toMatch(/14 chaves/);
    expect(user).not.toMatch(/(9|13) chaves/);
  });

  it('shape do prompt mantem null nos campos de sugestao (anti copy-the-shape)', () => {
    const shape = montarPromptInsight(ctxMinimo())[0].content.split('Regras de cada campo')[0];
    expect(shape).toMatch(/"ultima_compra":\s*null/);
    expect(shape).toMatch(/"temperatura_sugerida":\s*null/);
    expect(shape).toMatch(/"etapa_sugerida":\s*null/);
    expect(shape).not.toMatch(/"QUENTE"/); // temperatura de exemplo so na regra textual
  });
});

describe('lembretes temporais', () => {
  /** Contrato de 13 chaves (fase 4), usado como base para acrescentar `lembretes`. */
  const base13 = {
    resumo: 'Cliente pediu prazo.',
    memoria_novos_fatos: [],
    proxima_acao_em_dias: 3,
    proxima_acao_motivo: 'confirmar metragem',
    msg_sugerida: 'Oi!',
    nota_atendimento: 8,
    nota_ponto_forte: 'respondeu rápido',
    nota_ponto_melhoria: 'não confirmou o prazo',
    ultima_compra: null,
    temperatura_sugerida: null,
    temperatura_justificativa: '',
    etapa_sugerida: null,
    etapa_sugerida_motivo: '',
  };

  it('lembrete bem formado passa saneado', () => {
    const r = extrairInsight(JSON.stringify({
      ...base13,
      lembretes: [{ motivo: 'pediu para chamar em outubro', quando: '2026-10-15' }],
    }));
    expect(r?.lembretes).toEqual([{ motivo: 'pediu para chamar em outubro', quando: '2026-10-15' }]);
  });

  it('motivo trunca em 200', () => {
    const r = extrairInsight(JSON.stringify({
      ...base13,
      lembretes: [{ motivo: 'm'.repeat(500), quando: '2026-10-15' }],
    }));
    expect(r?.lembretes[0].motivo.length).toBe(200);
  });

  it('cap de 3 lembretes: 5 itens viram 3, na ordem', () => {
    const r = extrairInsight(JSON.stringify({
      ...base13,
      lembretes: [1, 2, 3, 4, 5].map((n) => ({ motivo: `lembrete ${n}`, quando: `2026-10-0${n}` })),
    }));
    expect(r?.lembretes).toHaveLength(3);
    expect(r?.lembretes.map((l) => l.motivo)).toEqual(['lembrete 1', 'lembrete 2', 'lembrete 3']);
  });

  it('data ilegivel ou impossivel derruba o item', () => {
    for (const quando of ['outubro', '15/10/2026', '2026-10', '2026-10-15T00:00:00Z', 42, null, '2026-13-45', '2026-02-30']) {
      const r = extrairInsight(JSON.stringify({ ...base13, lembretes: [{ motivo: 'chamar depois', quando }] }));
      expect(r?.lembretes).toEqual([]);
    }
  });

  it('motivo vazio, item nao-objeto e lembretes nao-array somem', () => {
    const sujo = extrairInsight(JSON.stringify({
      ...base13,
      lembretes: [42, 'em outubro', { quando: '2026-10-15' }, { motivo: '   ', quando: '2026-10-15' }, { motivo: 'ok', quando: '2026-10-15' }],
    }));
    expect(sujo?.lembretes).toEqual([{ motivo: 'ok', quando: '2026-10-15' }]);
    for (const lixo of ['2026-10-15', 42, { motivo: 'ok', quando: '2026-10-15' }, null]) {
      expect(extrairInsight(JSON.stringify({ ...base13, lembretes: lixo }))?.lembretes).toEqual([]);
    }
  });

  it('resposta no contrato de 13 chaves segue valida: lembretes vira [] (retrocompat)', () => {
    const r = extrairInsight(JSON.stringify(base13));
    expect(r?.resumo).toContain('prazo');
    expect(r?.lembretes).toEqual([]);
  });

  it('shape do prompt traz lembretes VAZIO (anti copy-the-shape)', () => {
    const shape = montarPromptInsight(ctxMinimo())[0].content.split('Regras de cada campo')[0];
    expect(shape).toMatch(/"lembretes":\s*\[\s*\]/);
    expect(shape).not.toMatch(/"motivo"/); // exemplo preenchido so na regra textual
  });

  it('system explica a regra: so marco temporal do cliente, data da mensagem, nunca inventar', () => {
    const regras = montarPromptInsight(ctxMinimo())[0].content.split('Regras de cada campo')[1];
    expect(regras).toMatch(/"lembretes"/);
    expect(regras).toMatch(/o padrão é \[\]/);
    expect(regras).toMatch(/CLIENTE/);
    expect(regras).toMatch(/AAAA-MM-DD/);
    expect(regras).toMatch(/DATA DA MENSAGEM/);
    expect(regras).toMatch(/[nN]unca invente/);
  });
});

describe('montarPromptInsight', () => {
  it('system exige JSON e proibe responder pelo cliente; user carrega lead, memoria e mensagens', () => {
    const msgs = montarPromptInsight(ctxMinimo());
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/JSON/);
    expect(msgs[1].content).toContain('Ana');
    expect(msgs[1].content).toContain('gripe');
    expect(msgs[1].content).toContain('quero orçamento');
  });
});
