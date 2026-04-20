-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "prefixo_profissional" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "especialidade" TEXT;

-- AlterTable: make responsavel_id nullable for pool (unassigned leads)
ALTER TABLE "Lead" ALTER COLUMN "responsavel_id" DROP NOT NULL;

-- AlterTable: add pool_enabled flag to Tenant
ALTER TABLE "Tenant" ADD COLUMN "pool_enabled" BOOLEAN NOT NULL DEFAULT false;
