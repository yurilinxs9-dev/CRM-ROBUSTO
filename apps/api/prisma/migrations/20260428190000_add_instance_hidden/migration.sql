-- CreateTable
CREATE TABLE IF NOT EXISTS "InstanceHidden" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InstanceHidden_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InstanceHidden_user_id_instance_id_key" ON "InstanceHidden"("user_id", "instance_id");
CREATE INDEX IF NOT EXISTS "InstanceHidden_tenant_id_idx" ON "InstanceHidden"("tenant_id");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstanceHidden_user_id_fkey') THEN
    ALTER TABLE "InstanceHidden" ADD CONSTRAINT "InstanceHidden_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstanceHidden_instance_id_fkey') THEN
    ALTER TABLE "InstanceHidden" ADD CONSTRAINT "InstanceHidden_instance_id_fkey"
      FOREIGN KEY ("instance_id") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstanceHidden_tenant_id_fkey') THEN
    ALTER TABLE "InstanceHidden" ADD CONSTRAINT "InstanceHidden_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;
