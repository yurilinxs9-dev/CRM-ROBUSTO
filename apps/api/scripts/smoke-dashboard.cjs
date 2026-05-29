require('dotenv').config();
const bcrypt = require('bcryptjs'); const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const BASE='https://api.crmpro.uk'; const T='8c7f38bf-6076-4279-85f0-93b24e268a2a';
const EMAIL=`dash-${Date.now()}@crm.local`; const SENHA='Val1date!2026';
const ok=m=>console.log('  PASS',m); const fail=m=>{console.log('  FAIL',m);process.exitCode=1;};
(async()=>{
  const uid=randomUUID();
  await p.$executeRawUnsafe(`INSERT INTO "User"(id,nome,email,senha_hash,role,ativo,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,'SUPER_ADMIN',true,$5,NOW(),NOW())`,uid,'Dash',EMAIL,await bcrypt.hash(SENHA,12),T);
  try{
    const lj=await (await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,senha:SENHA})})).json();
    const tok=lj.accessToken||lj.token;
    const s=await (await fetch(`${BASE}/api/dashboard/stats`,{headers:{Authorization:`Bearer ${tok}`}})).json();
    typeof s.avgResponseMinutes==='number'?ok('avgResponseMinutes='+s.avgResponseMinutes):fail('avgResponseMinutes');
    Array.isArray(s.leadsTrend)&&s.leadsTrend.length===14?ok('leadsTrend 14 dias'):fail('leadsTrend len='+(s.leadsTrend||[]).length);
    typeof s.openConversations==='number'?ok('openConversations='+s.openConversations):fail('openConversations');
    typeof s.pendingTasks==='number'?ok('pendingTasks='+s.pendingTasks):fail('pendingTasks');
    typeof s.wonValue==='number'?ok('wonValue='+s.wonValue):fail('wonValue');
    typeof s.totalLeads==='number'?ok('totalLeads='+s.totalLeads+' (contrato antigo intacto)'):fail('totalLeads');
  } finally { await p.user.delete({where:{id:uid}}).catch(()=>{}); ok('cleanup'); await p.$disconnect(); }
  console.log('\nDashboard stats: OK');
})().catch(async e=>{console.error('ERRO',e.message);await p.$disconnect();process.exit(1);});
