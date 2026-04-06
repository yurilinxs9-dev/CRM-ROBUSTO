import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

async function main() {
  const prisma = new PrismaClient();
  const email = process.env.ADMIN_EMAIL || 'admin@crm.com';
  const senha = process.env.ADMIN_SENHA || 'Admin@2026';

  const senha_hash = await bcrypt.hash(senha, 12);

  const existing = await prisma.user.findUnique({ where: { email } });
  let tenantId: string;
  let userId: string;

  if (existing) {
    userId = existing.id;
    tenantId = existing.tenant_id;
    await prisma.user.update({
      where: { id: userId },
      data: { senha_hash, role: 'SUPER_ADMIN' },
    });
  } else {
    tenantId = randomUUID();
    userId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO "User" ("id", "nome", "email", "senha_hash", "role", "ativo", "tenant_id", "created_at", "updated_at")
          VALUES (${userId}, ${'Administrador'}, ${email}, ${senha_hash}, ${'SUPER_ADMIN'}, true, ${tenantId}, NOW(), NOW())`,
      );
      await tx.tenant.create({
        data: { id: tenantId, nome: 'Admin Tenant', owner_id: userId },
      });
    });
  }

  const pipeline = await prisma.pipeline.upsert({
    where: { id: 'pipeline-default' },
    create: {
      id: 'pipeline-default',
      nome: 'Pipeline Principal',
      descricao: 'Funil de vendas padrao',
      ativo: true,
      ordem: 0,
      tenant_id: tenantId,
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
      create: { id: `stage-${stage.ordem}`, ...stage, pipeline_id: pipeline.id, tenant_id: tenantId },
      update: {},
    });
  }

  console.log('Admin criado:', email);
  console.log('Tenant:', tenantId);
  console.log('Pipeline criado:', pipeline.nome);
  console.log('7 estagios criados');
  console.log('\nCredenciais:');
  console.log('  Email:', email);
  console.log('  Senha:', senha);

  await prisma.$disconnect();
}

main().catch(console.error);
