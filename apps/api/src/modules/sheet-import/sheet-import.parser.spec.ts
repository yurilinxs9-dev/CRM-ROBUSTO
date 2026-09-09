import {
  classifyCompanyType,
  isTestRow,
  mapRow,
  normalizePhone,
  parseCsv,
} from './sheet-import.parser';

describe('parseCsv', () => {
  it('separa colunas, respeita aspas com vírgula interna e CRLF', () => {
    const csv = 'id,nome,cidade\r\nl:1,"Silva, João",Curitiba\r\nl:2,Maria,"São José dos Pinhais"\r\n';
    expect(parseCsv(csv)).toEqual([
      { id: 'l:1', nome: 'Silva, João', cidade: 'Curitiba' },
      { id: 'l:2', nome: 'Maria', cidade: 'São José dos Pinhais' },
    ]);
  });

  it('aspas duplicadas dentro de aspas viram uma aspa', () => {
    expect(parseCsv('a,b\n"x ""y"" z",1\n')).toEqual([{ a: 'x "y" z', b: '1' }]);
  });

  it('linha vazia no fim é ignorada e coluna faltante vira string vazia', () => {
    expect(parseCsv('a,b,c\n1,2\n\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('preserva a ordem das colunas nas chaves do objeto', () => {
    const [row] = parseCsv('z,a,m\n1,2,3\n');
    expect(Object.keys(row)).toEqual(['z', 'a', 'm']);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['p:+5519997094696', '5519997094696'],
    ['p:11945550754', '5511945550754'],
    ['p:+554797887666', '554797887666'],
    ['(41) 99293-8568', '5541992938568'],
    ['5541992938568', '5541992938568'],
  ])('%s -> %s', (raw, esperado) => {
    expect(normalizePhone(raw)).toBe(esperado);
  });

  it.each([['p:<test lead: dummy data for Telefone>'], [''], ['123'], ['p:+1 555 0100']])(
    'inválido %s -> null',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe('classifyCompanyType', () => {
  it.each([
    ['Ltda', 'ME_LTDA'],
    ['LTDA', 'ME_LTDA'],
    ['lTDA', 'ME_LTDA'],
    ['ME', 'ME_LTDA'],
    ['Mei e LTDA', 'ME_LTDA'],
    ['Limitada', 'ME_LTDA'],
    ['Mei', 'MEI'],
    ['MEI', 'MEI'],
    ['mei', 'MEI'],
    ['Pessoa Física', 'PESSOA_FISICA'],
    ['Ainda não tenho empresa', 'PESSOA_FISICA'],
    ['Autônomo', 'PESSOA_FISICA'],
    ['Sim', 'NAO_INFORMADO'],
    ['Meu', 'NAO_INFORMADO'],
    ['Outro', 'NAO_INFORMADO'],
    ['', 'NAO_INFORMADO'],
  ])('%s -> %s', (raw, esperado) => {
    expect(classifyCompanyType(raw)).toBe(esperado);
  });
});

describe('isTestRow', () => {
  it('detecta linha de teste do Meta pelo nome, telefone ou e-mail', () => {
    expect(
      isTestRow({ 'Nome Completo': '<test lead: dummy data for Nome Completo>', Telefone: 'p:1', Email: 'x' }),
    ).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:<test lead: dummy data for Telefone>', Email: 'x' })).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:1', Email: 'test@meta.com' })).toBe(true);
  });

  it('linha real não é teste', () => {
    expect(isTestRow({ 'Nome Completo': 'Eduardo jr - Deka', Telefone: 'p:+5519997094696', Email: 'a@b.com' })).toBe(false);
  });
});

const LINHA_REAL: Record<string, string> = {
  id: 'l:1464784368803570',
  created_time: '2026-09-04T11:17:13-05:00',
  ad_id: 'ag:52542418411334',
  ad_name: '02',
  adset_id: 'as:52542418412334',
  adset_name: '[Brasilia/Goiania/SãoPaulo] [PI + PA] [ADV]',
  campaign_id: 'c:52542418410934',
  campaign_name: '[LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3',
  form_id: 'f:1020102430402581',
  form_name: 'Formulário PL Master',
  is_organic: 'false',
  platform: 'ig',
  'há_quantos_anos_na_atua_com_vendas_de_consórcio?': '3 anos',
  'possui_estrutura_física?': 'Não',
  'tem_quantos_vendedores?': '1',
  'média_de_produção_mensal?': '500 mil',
  'sua_empresa_é_mei_ou_ltda?': 'Mei',
  Email: 'joseeduardojunior56@gmail.com',
  'Nome Completo': 'Eduardo jr - Deka',
  Telefone: 'p:+5519997094696',
  Cidade: 'Paulínia',
  estado: 'SP',
  lead_status: 'CREATED',
};

describe('mapRow', () => {
  it('linha real vira lead com campos, tag MEI, atribuição e texto da atividade', () => {
    const r = mapRow(LINHA_REAL);
    if (!r.ok) throw new Error(r.motivo);
    expect(r.lead.sourceRowId).toBe('l:1464784368803570');
    expect(r.lead.nome).toBe('Eduardo jr - Deka');
    expect(r.lead.telefone).toBe('5519997094696');
    expect(r.lead.email).toBe('joseeduardojunior56@gmail.com');
    expect(r.lead.companyType).toBe('MEI');
    expect(r.lead.tags).toEqual(['MEI']);
    expect(r.lead.dadosCustom).toEqual({
      tipo_empresa: 'MEI',
      tipo_empresa_resposta: 'Mei',
      anos_consorcio: '3 anos',
      estrutura_fisica: 'Não',
      qtd_vendedores: '1',
      producao_mensal: '500 mil',
      cidade: 'Paulínia',
      estado: 'SP',
      form_data: '2026-09-04',
    });
    expect(r.lead.attribution).toEqual({
      utm_source: 'ig',
      utm_medium: 'paid',
      utm_campaign: '[LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3',
      campaignid: '52542418410934',
      adgroupid: '52542418412334',
      creative: '52542418411334',
    });
    expect(r.lead.atividadeTexto).toBe(
      'Tipo de empresa: MEI (Mei) · Anos com consórcio: 3 anos · Estrutura física: Não · Quantidade de vendedores: 1 · Produção mensal: 500 mil · Paulínia/SP · Campanha: [LEADS] [WHATSAPP] [Parcerias PL Master] [+LEADS] V3 · Conjunto: [Brasilia/Goiania/SãoPaulo] [PI + PA] [ADV] · Anúncio: 02',
    );
  });

  it('pessoa física recebe tag "Pessoa Física"; LTDA e não informado não recebem tag', () => {
    const pf = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Pessoa Física' });
    const ltda = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Ltda' });
    const sim = mapRow({ ...LINHA_REAL, 'sua_empresa_é_mei_ou_ltda?': 'Sim' });
    expect(pf.ok && pf.lead.tags).toEqual(['Pessoa Física']);
    expect(ltda.ok && ltda.lead.tags).toEqual([]);
    expect(sim.ok && sim.lead.tags).toEqual([]);
    expect(sim.ok && sim.lead.dadosCustom.tipo_empresa).toBe('Não informado');
  });

  it('e-mail inválido vira null, nome vazio vira o telefone', () => {
    const r = mapRow({ ...LINHA_REAL, Email: 'sem-arroba', 'Nome Completo': '  ' });
    expect(r.ok && r.lead.email).toBeNull();
    expect(r.ok && r.lead.nome).toBe('5519997094696');
  });

  it('linha de teste do Meta é pulada com motivo', () => {
    const r = mapRow({ ...LINHA_REAL, 'Nome Completo': '<test lead: dummy data for Nome Completo>' });
    expect(r).toEqual({ ok: false, motivo: 'linha de teste do Meta' });
  });

  it('telefone inválido é pulado com motivo', () => {
    const r = mapRow({ ...LINHA_REAL, Telefone: 'p:+1 555 0100' });
    expect(r).toEqual({ ok: false, motivo: 'telefone inválido: p:+1 555 0100' });
  });

  it('sem id da linha é pulada', () => {
    expect(mapRow({ ...LINHA_REAL, id: '' })).toEqual({ ok: false, motivo: 'linha sem id' });
  });

  it('orgânico vira utm_medium organic e plataforma vazia vira meta', () => {
    const r = mapRow({ ...LINHA_REAL, is_organic: 'true', platform: '' });
    expect(r.ok && r.lead.attribution.utm_medium).toBe('organic');
    expect(r.ok && r.lead.attribution.utm_source).toBe('meta');
  });

  it('pergunta renomeada é achada por posição entre platform e Email', () => {
    // Reconstrói mantendo a posição: a coluna renomeada fica onde estava.
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(LINHA_REAL)) {
      row[k === 'há_quantos_anos_na_atua_com_vendas_de_consórcio?' ? 'quantos_anos_de_consorcio?' : k] = v;
    }
    const r = mapRow(row);
    expect(r.ok && r.lead.dadosCustom.anos_consorcio).toBe('3 anos');
  });

  it('pergunta extra desconhecida entra só no texto da atividade', () => {
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(LINHA_REAL)) {
      row[k] = v;
      if (k === 'sua_empresa_é_mei_ou_ltda?') row['qual_seu_faturamento?'] = '1 milhão';
    }
    const r = mapRow(row);
    expect(r.ok && r.lead.dadosCustom).not.toHaveProperty('qual_seu_faturamento?');
    expect(r.ok && r.lead.atividadeTexto).toContain('qual seu faturamento: 1 milhão');
  });

  it('data do formulário é convertida para AAAA-MM-DD em horário de Brasília', () => {
    // 23:30 em -05:00 = 01:30 do dia seguinte em -03:00.
    const r = mapRow({ ...LINHA_REAL, created_time: '2026-09-04T23:30:00-05:00' });
    expect(r.ok && r.lead.dadosCustom.form_data).toBe('2026-09-05');
  });
});
