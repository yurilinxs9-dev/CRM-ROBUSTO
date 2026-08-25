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

describe('montarPromptInsight', () => {
  it('system exige JSON e proibe responder pelo cliente; user carrega lead, memoria e mensagens', () => {
    const msgs = montarPromptInsight({
      lead: { nome: 'Ana', telefone: '55999', etapa: 'Consulta', temperatura: 'MORNO', valor_estimado: 1500, ultima_interacao: new Date('2026-08-20') },
      insightAnterior: { resumo: 'antigo', memoria: [{ fato: 'gripe', quando_dito: '2026-08-10' }] },
      mensagens: [{ de: 'cliente', texto: 'quero orçamento', em: new Date('2026-08-20') }],
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/JSON/);
    expect(msgs[1].content).toContain('Ana');
    expect(msgs[1].content).toContain('gripe');
    expect(msgs[1].content).toContain('quero orçamento');
  });
});
