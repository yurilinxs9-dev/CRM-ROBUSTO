// Focused integration proof. ALL mutations run inside an intentionally rolled-back transaction.
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const {PrismaClient,Prisma}=require('@prisma/client');
const bcrypt=require('bcryptjs');
const {FinanceService}=require('../dist/modules/finance/finance.service');
const {FinanceAuthService}=require('../dist/modules/finance/finance-auth.service');
const p=new PrismaClient();
(async()=>{
 const tenantId='a44772ed-1382-4400-84fc-3fa350e23e42';const userId='4f72be61-f5a6-4222-bbfd-074c4da31b87';
 const account=await p.user.findFirstOrThrow({where:{id:userId,tenant_id:tenantId,ativo:true},select:{id:true,nome:true,email:true,role:true,ativo:true}});const user={...account,tenantId};
 const sentinel=new Error('ROLLBACK_VERIFICATION');let verified=false;
 const tables=['FinanceAccess','FinanceSession','FinanceRule','FinanceSale','FinanceInstallment','FinanceAudit'];
 const before=await Promise.all([p.financeAccess.count(),p.financeSession.count(),p.financeRule.count(),p.financeSale.count(),p.financeInstallment.count(),p.financeAudit.count()]);
 try{await p.$transaction(async tx=>{
   const facade=new Proxy(tx,{get(target,key){if(key==='$transaction')return async input=>typeof input==='function'?input(tx):Promise.all(input);return Reflect.get(target,key);}});
   const svc=new FinanceService(facade);const auth=new FinanceAuthService(facade);
   await assert.rejects(()=>svc.dashboard({...user,id:'other',role:'SUPER_ADMIN'},{}));await assert.rejects(()=>auth.validate(user));
   const secret=randomBytes(24).toString('hex');
   await tx.financeAccess.upsert({where:{tenant_id:tenantId},create:{tenant_id:tenantId,user_id:userId,password_hash:await bcrypt.hash(secret,12)},update:{password_hash:await bcrypt.hash(secret,12),failed_attempts:0,locked_until:null}});
   const session=await auth.login(user,{password:secret});assert(session.token);await auth.validate(user,session.token);await assert.rejects(()=>auth.validate({...user,id:'other',role:'SUPER_ADMIN'},session.token));await auth.logout(user,session.token);await assert.rejects(()=>auth.validate(user,session.token));
   const first=await svc.sync(user);const second=await svc.sync(user);assert.equal(second.created,0);
   const current=await svc.rule(user);const initial=await svc.updateRule(user,{expectedVersion:current.version,total_bps:50,distribution:[20,10,10,5,5]});
   const requestId=randomUUID();const input={requestId,description:'Verification only — rolled back',amount:'20000000.00',closed_on:'2026-01-15'};
   const sale=await svc.manual(user,input);assert.equal(sale.commission_total,'100000.00');assert.equal((await svc.manual(user,input)).id,sale.id);
   let rows=await tx.financeInstallment.findMany({where:{tenant_id:tenantId,sale_id:sale.id},orderBy:{number:'asc'}});assert.equal(rows.length,5);assert.deepEqual(rows.map(i=>i.amount.toFixed(2)),['40000.00','20000.00','20000.00','10000.00','10000.00']);
   await svc.updateRule(user,{expectedVersion:initial.version,total_bps:100,distribution:[50,50]});assert.equal(await tx.financeInstallment.count({where:{sale_id:sale.id}}),5);
   const row=rows[0];let updated=await svc.updateInstallment(user,row.id,{expectedVersion:row.version,due_on:'2026-02-05'});assert.equal(updated.due_on,'2026-02-05');assert(updated.due_overridden);
   await assert.rejects(()=>svc.updateInstallment(user,row.id,{expectedVersion:row.version,received_on:'2026-02-06'}));
   updated=await svc.updateInstallment(user,row.id,{expectedVersion:updated.version,received_on:'2026-02-06'});assert.equal(updated.status,'received');
   const live=await tx.financeSale.findUniqueOrThrow({where:{id:sale.id}});await assert.rejects(()=>svc.cancel(user,sale.id,{expectedVersion:live.version}));
   const history=await svc.history(user,{sale_id:sale.id,status:'received',page:1});assert.equal(history.total,1);assert.equal(history.rows[0].amount,'40000.00');
   const dashboard=await svc.dashboard(user,{month:'2026-02',months:5});assert(new Prisma.Decimal(dashboard.monthly[0].received).gte('40000'));assert(dashboard.monthly[0].installments.some(i=>i.id===row.id));
   await svc.updateInstallment(user,row.id,{expectedVersion:updated.version,received_on:null});const fresh=await tx.financeSale.findUniqueOrThrow({where:{id:sale.id}});await svc.cancel(user,sale.id,{expectedVersion:fresh.version});assert.equal((await svc.history(user,{sale_id:sale.id})).total,0);
   assert(await tx.financeAudit.count({where:{tenant_id:tenantId,action:'installment.updated'}})>0);
   console.log(JSON.stringify({integration:'passed',imported:first.created,duplicateImports:second.created,manualSchedule:'5 installments / 100000.00',receiptAndDueEdit:'passed',independentSessionAndTenantIsolation:'passed'}));
   verified=true;throw sentinel;
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,timeout:90000});}catch(e){if(e!==sentinel)throw e;}
 assert(verified);
 const after=await Promise.all([p.financeAccess.count(),p.financeSession.count(),p.financeRule.count(),p.financeSale.count(),p.financeInstallment.count(),p.financeAudit.count()]);
 assert.deepEqual(after,before,'Financial rows changed outside rolled-back verification');
 const rls=await p.$queryRawUnsafe(`SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN (${tables.map(t=>"'"+t+"'").join(',')})`);assert.equal(rls.length,6);assert(rls.every(t=>t.relrowsecurity));
 console.log('PASS: transaction rolled back; no credential, sale or receipt persisted. RLS enabled on all six tables.');
})().catch(e=>{console.error('Verification failed:',e.name,e.message);process.exitCode=1}).finally(()=>p.$disconnect());
