import { canAccessPlSales, plSaleSchema, plRanking, type PlDashboard } from './pl-sales';
import { formatPlAmountInput, plAmountCaret } from './pl-amount-input';
const tenant='a44772ed-1382-4400-84fc-3fa350e23e42';
const id='386d67e1-5ac6-4ec6-81fa-814e65768c31';
const sale={lead_id:id,seller_id:id,contract_number:'pl-123',amount:'250.000,50',sold_on:'2026-01-01',note:''};
describe('PL sales presentation',()=>{
 it('restricts the tab to authorized roles in the PL tenant',()=>{expect(canAccessPlSales(tenant,'GERENTE')).toBe(true);expect(canAccessPlSales(tenant,'VISUALIZADOR')).toBe(false);expect(canAccessPlSales('other','SUPER_ADMIN')).toBe(false);});
 it('preserves Brazilian thousands and cents without silently misreading decimal dots',()=>{expect(plSaleSchema.parse(sale)).toMatchObject({amount:'250000.50',contract_number:'PL-123'});expect(()=>plSaleSchema.parse({...sale,amount:'250000.50'})).toThrow();});
 it.each([
  ['250000', 'R$ 250.000,00', '250000.00'],
  ['250000,5', 'R$ 250.000,50', '250000.50'],
  ['R$ 250.000,75', 'R$ 250.000,75', '250000.75'],
  ['0,01', 'R$ 0,01', '0.01'],
  ['999999999999,99', 'R$ 999.999.999.999,99', '999999999999.99'],
 ])('formats %s without changing the saved credit', (typed, display, amount) => {
  const formatted = formatPlAmountInput(typed, true);
  expect(formatted?.replace(/\u00a0/g, ' ')).toBe(display);
  expect(plSaleSchema.parse({...sale,amount:formatted}).amount).toBe(amount);
 });
 it('keeps typing and deleting usable without shifting reais into cents', () => {
  expect(formatPlAmountInput('R$ 25.0000')).toBe('R$ 250.000');
  expect(formatPlAmountInput('R$ 250.000,')).toBe('R$ 250.000,');
  expect(formatPlAmountInput('R$ ')).toBe('');
  expect(formatPlAmountInput('')).toBe('');
  expect(formatPlAmountInput('-250000')).toBeNull();
  expect(formatPlAmountInput('250000,123')).toBeNull();
  expect(plAmountCaret('R$ 25.0000',10,'R$ 250.000')).toBe(10);
  expect(plAmountCaret('R$ 2510.000',6,'R$ 2.510.000')).toBe(7);
  expect(()=>plSaleSchema.parse({...sale,amount:formatPlAmountInput('1000000000000',true)})).toThrow();
 });
 it('rejects impossible dates and zero-credit contracts',()=>{expect(()=>plSaleSchema.parse({...sale,sold_on:'2026-02-30'})).toThrow();expect(()=>plSaleSchema.parse({...sale,amount:'0,00'})).toThrow();});
 it('shows zero-sales members without inventing goals and retains historic sellers',()=>{const data={ranking:[{seller_id:'inactive',seller_name:'Antiga',amount:'500.00',contracts:1,target:null}],members:[{id,name:'Nova'}],goals:[]} as unknown as PlDashboard;expect(plRanking(data)).toEqual([{seller_id:'inactive',seller_name:'Antiga',amount:'500.00',contracts:1,target:null},{seller_id:id,seller_name:'Nova',amount:'0.00',contracts:0,target:null}]);});
});
