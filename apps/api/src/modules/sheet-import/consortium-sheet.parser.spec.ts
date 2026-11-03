import { mapConsortiumRow, resolveConsortiumMatch } from './consortium-sheet.parser';

const row = {
  id: 'l:1', created_time: '2026-11-03T12:00:00-03:00',
  nome_completo: 'Pessoa Teste', telefone: 'p:+5511999991234', email: 'pessoa@example.com', cidade: 'Campinas',
  'o_que_você_quer_conquistar?': 'imóvel',
  'qual_o_valor_do_imóvel_que_você_procura?': 'r$_200_a_400_mil',
  'quando_pretende_contratar?': 'em_1_a_3_meses',
  'qual_parcela_cabe_no_seu_bolso?': 'até_r$_500',
  'você_tem_valor_para_dar_de_lance?': 'quero_entender_como_funciona',
};
describe('consortium sheet mapping', () => {
  it('maps customer answers without turning ranges into an exact credit', () => {
    const result = mapConsortiumRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.motivo);
    expect(result.lead).toMatchObject({ nome: 'Pessoa Teste', telefone: '5511999991234', email: 'pessoa@example.com', dadosCustom: {
      bem_de_interesse: 'Imóvel', pl_objetivo: 'Imóvel', pl_faixa_imovel: 'R$ 200 a 400 mil',
      pl_prazo: 'Em 1 a 3 meses', pl_parcela: 'Até R$ 500', pl_lance: 'Quero entender como funciona', pl_cidade: 'Campinas',
    } });
    expect(result.lead).not.toHaveProperty('valor_estimado');
    expect(result.lead.dadosCustom).not.toHaveProperty('tipo_empresa');
  });
  it.each(['os_dois', 'ainda_estou_decidindo', 'veículo'])('preserves %s without guessing an asset', (answer) => {
    const result = mapConsortiumRow({ ...row, 'o_que_você_quer_conquistar?': answer });
    if (!result.ok) throw new Error(result.motivo);
    expect(result.lead.dadosCustom.bem_de_interesse).toBeUndefined();
    expect(result.lead.dadosCustom.pl_objetivo).toBeTruthy();
  });
  it('rejects tests and invalid phones', () => {
    expect(mapConsortiumRow({ ...row, email: 'test@meta.com' }).ok).toBe(false);
    expect(mapConsortiumRow({ ...row, telefone: '' }).ok).toBe(false);
  });
});

const existing = { id: 'a', telefone: '11999991234', email: 'pessoa@example.com', pipeline_id: 'pl', dados_custom: {}, tags: [] };
describe('conservative consortium matching', () => {
  it('finds an existing contact despite country prefix formatting', () => {
    expect(resolveConsortiumMatch([existing], '5511999991234', null, 'pl')?.id).toBe('a');
  });
  it('holds another pipeline instead of duplicating or moving its lead', () => {
    expect(() => resolveConsortiumMatch([{ ...existing, pipeline_id: 'partners' }], '5511999991234', null, 'pl')).toThrow(/revisão/);
  });
  it('holds an email-only match and a ninth-digit ambiguity', () => {
    expect(() => resolveConsortiumMatch([existing], '5511888881234', 'pessoa@example.com', 'pl')).toThrow(/revisão/);
    expect(() => resolveConsortiumMatch([{ ...existing, telefone: '1199991234' }], '5511999991234', null, 'pl')).toThrow(/revisão/);
  });
  it('holds duplicate matches instead of picking one seller', () => {
    expect(() => resolveConsortiumMatch([existing, { ...existing, id: 'b' }], '5511999991234', null, 'pl')).toThrow(/revisão/);
  });
  it('allows a new contact', () => {
    expect(resolveConsortiumMatch([existing], '5511888881234', 'other@example.com', 'pl')).toBeNull();
  });
});
