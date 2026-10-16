import { canAccessPlSales, plSaleSchema, plRanking, type PlDashboard } from './pl-sales';
const tenant='a44772ed-1382-4400-84fc-3fa350e23e42';
const id='386d67e1-5ac6-4ec6-81fa-814e65768c31';
const sale={lead_id:id,seller_id:id,contract_number:'pl-123',amount:'250.000,50',sold_on:'2026-01-01',note:''};
describe('PL sales presentation',()=>{
 it('restricts the tab to authorized roles in the PL tenant',()=>{expect(canAccessPlSales(tenant,'GERENTE')).toBe(true);expect(canAccessPlSales(tenant,'VISUALIZADOR')).toBe(false);expect(canAccessPlSales('other','SUPER_ADMIN')).toBe(false);});
 it('preserves Brazilian thousands and cents without silently misreading decimal dots',()=>{expect(plSaleSchema.parse(sale)).toMatchObject({amount:'250000.50',contract_number:'PL-123'});expect(()=>plSaleSchema.parse({...sale,amount:'250000.50'})).toThrow();});
 it('rejects impossible dates and zero-credit contracts',()=>{expect(()=>plSaleSchema.parse({...sale,sold_on:'2026-02-30'})).toThrow();expect(()=>plSaleSchema.parse({...sale,amount:'0,00'})).toThrow();});
 it('shows zero-sales members without inventing goals and retains historic sellers',()=>{const data={ranking:[{seller_id:'inactive',seller_name:'Antiga',amount:'500.00',contracts:1,target:null}],members:[{id,name:'Nova'}],goals:[]} as unknown as PlDashboard;expect(plRanking(data)).toEqual([{seller_id:'inactive',seller_name:'Antiga',amount:'500.00',contracts:1,target:null},{seller_id:id,seller_name:'Nova',amount:'0.00',contracts:0,target:null}]);});
});
