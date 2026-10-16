import { isPlPipeline, PL_TENANT, PL_PIPELINE, simulatorFields, isSimulation, acceptsClassification, monthlySummary } from './pl-sales.domain';
describe('Consórcio PL domain', () => {
 it('scopes workflow to tenant and pipeline', () => { expect(isPlPipeline(PL_TENANT,PL_PIPELINE)).toBe(true); expect(isPlPipeline('other',PL_PIPELINE)).toBe(false); });
 it('normalizes marker', () => { expect(isSimulation('*NOVA  SIMULAÇÃO DE CONSÓRCIO*\nNome: Ana')).toBe(true); expect(isSimulation('Olá')).toBe(false); });
 it('extracts simulation', () => { expect(simulatorFields('*Nova Simulação de Consórcio*\nNome: Ana\nObjetivo: Casa\nValor do Crédito: R$ 150.000,00')).toEqual({nome:'Ana',objetivo:'Casa',credito:'R$ 150.000,00'}); });
 it('requires confident AI classification', () => { expect(acceptsClassification('{"intent":"consorcio","confidence":0.98}')).toBe(true); expect(acceptsClassification('{"intent":"consorcio","confidence":0.5}')).toBe(false); expect(acceptsClassification('invalid')).toBe(false); expect(acceptsClassification('{"intent":"parceria","confidence":1}')).toBe(false); });
 it('sums cents exactly and excludes cancelled sales', () => { expect(monthlySummary([{amount:'0.10',status:'ACTIVE'},{amount:'0.20',status:'ACTIVE'},{amount:'10.00',status:'CANCELLED'}], '1.00')).toEqual({total:'0.30',contracts:2,target:'1.00',remaining:'0.70',percentage:30}); });
 it('does not invent goal', () => expect(monthlySummary([],null).target).toBeNull());
});
