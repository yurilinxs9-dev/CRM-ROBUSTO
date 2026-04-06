import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

async function main() {
  const prisma = new PrismaClient();
  const email = process.env.ADMIN_EMAIL || 'admin@crm.com';
  const senha = process.env.ADMIN_SENHA || 'Admin@2026';

  const senha_hash = await bcrypt.hash(senha, 12);

  const pipeline = await prisma.pipeline.upsert({
    where: { id: 'pipeline-default' },
    create: {
      id: 'pipeline-default',
      nome: 'Pipeline Principal',
      descricao: 'Funil de vendas padrao',
      ativo: true,
      ordem: 0,
    },
    update: {},
  });

  const stages = [
    { nome: 'Novo Lead', cor: '#3498DB', ordem: 1 },
    { nome: 'Primeiro Contato', cor: '#1ABC9C', ordem: 2 },
    { nome: 'Em Negociacao', cor: '#F1C40F', ordem: 3 },
    { nome: 'Proposta Enviada', cor: '#E67E22', ordem: 4 },
    { nome: 'Fechamento', cor: '#27AE60', ordem: 5 },
    { nome: 'Ganho', cor: '#1E8449', ordem: 6, is_won: true },
    { nome: 'Perdido', cor: '#E74C3C', ordem: 7, is_lost: true },
  ];

  for (const stage of stages) {
    await prisma.stage.upsert({
      where: { id: `stage-${stage.ordem}` },
      create: { id: `stage-${stage.ordem}`, ...stage, pipeline_id: pipeline.id },
      update: {},
    });
  }

  const admin = await prisma.user.upsert({
    where: { email },
    create: { nome: 'Administrador', email, senha_hash, role: 'SUPER_ADMIN' },
    update: { senha_hash, role: 'SUPER_ADMIN' },
  });

  console.log('Admin criado:', admin.email);
  console.log('Pipeline criado:', pipeline.nome);
  console.log('7 estagios criados');
  console.log('\nCredenciais:');
  console.log('  Email:', email);
  console.log('  Senha:', senha);

  await prisma.$disconnect();
}

main().catch(console.error);
