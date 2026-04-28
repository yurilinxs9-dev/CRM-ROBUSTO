-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "prefix_enabled" BOOLEAN NOT NULL DEFAULT true;
