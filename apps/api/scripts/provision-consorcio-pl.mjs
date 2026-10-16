// Adiciona apenas o funil PL e as três novas tabelas. Sem migrate deploy/db push.
// Uso: node scripts/provision-consorcio-pl.mjs [--apply]
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
const tenant = 'a44772ed-1382-4400-84fc-3fa350e23e42';
const pipeline = '6f749216-8d83-44ed-8fd0-1c57720c9f11';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const url = env.match(/^DIRECT_URL=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
if (!url) throw new Error('DIRECT_URL obrigatória');
const prisma = new PrismaClient({ datasources: { db: { url } }, errorFormat: 'minimal' });
const tables = ['PLSale', 'PLMonthlyGoal', 'PLSalesAudit'];
async function inspect(db) {
 const workspace = await db.tenant.findUniqueOrThrow({where:{id:tenant},select:{id:true,nome:true,pool_enabled:true,round_robin_enabled:true}});
 const pipelines = await db.pipeline.findMany({where:{tenant_id:tenant},orderBy:{ordem:'asc'},select:{id:true,nome:true,ordem:true,_count:{select:{leads:true,stages:true}}}});
 const existing = await db.$queryRaw`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('PLSale','PLMonthlyGoal','PLSalesAudit')`;
 const partners = await db.salesPartner.count({where:{tenant_id:tenant}});
 const production = await db.partnerDailyProduction.aggregate({where:{tenant_id:tenant},_count:true,_sum:{amount:true}});
 const goals = await db.partnerMonthlyGoal.count({where:{tenant_id:tenant}});
 const instances = await db.whatsappInstance.findMany({where:{tenant_id:tenant},select:{nome:true,status:true,telefone:true}});
 return {workspace,pipelines,tables:existing,partners,production,goals,instances};
}
try {
 const before=await inspect(prisma); console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'dry-run',before},null,2));
 if (process.argv.includes('--apply')) {
  await prisma.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(6101617)`;
   const existing=await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('PLSale','PLMonthlyGoal','PLSalesAudit')`;
   if(existing.length!==0 && existing.length!==tables.length) throw new Error('Estado parcial das tabelas PL; não aplicar automaticamente');
   if(!existing.length){
    const sql=readFileSync(new URL('../prisma/migrations/20261016170000_pl_sales/migration.sql',import.meta.url),'utf8');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
   }
   const found=await tx.pipeline.findFirst({where:{OR:[{id:pipeline},{tenant_id:tenant,nome:'Consórcio PL'}]},include:{stages:true}});
   if(found){if(found.id!==pipeline||found.tenant_id!==tenant||found.stages.length===0)throw new Error('Funil existente diverge do provisionamento esperado');return;}
   const order=await tx.pipeline.aggregate({where:{tenant_id:tenant},_max:{ordem:true}});
   const names=['Novo','Em atendimento','Simulação enviada','Negociação','Contrato fechado','Perdido'];
   const colors=['#38bdf8','#818cf8','#a78bfa','#f59e0b','#22c55e','#ef4444'];
   await tx.pipeline.create({data:{id:pipeline,tenant_id:tenant,nome:'Consórcio PL',descricao:'Clientes de consórcio da PL. Distribuição manual pela gestão.',ativo:true,cor:'#10b981',ordem:(order._max.ordem??0)+1,stages:{create:names.map((nome,ordem)=>({nome,ordem,cor:colors[ordem],tenant_id:tenant,is_won:ordem===4,is_lost:ordem===5}))}}});
  },{timeout:90000,maxWait:10000});
  console.log(JSON.stringify({after:await inspect(prisma)},null,2));
 }
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally {await prisma.$disconnect();}
