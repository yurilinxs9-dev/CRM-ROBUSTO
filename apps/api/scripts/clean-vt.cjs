require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const VT = '940f733d-0563-4589-a72e-afbbdff3098d';
(async()=>{
  const before = await p.message.count({ where:{ tenant_id: VT } });
  const del = await p.message.deleteMany({ where:{ tenant_id: VT } });
  await p.lead.updateMany({ where:{ tenant_id: VT }, data:{ mensagens_nao_lidas: 0, ultima_interacao: null } });
  console.log('mensagens antes:', before, '| deletadas:', del.count);
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1);});
