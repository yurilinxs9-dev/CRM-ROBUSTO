-- Create Tenant table if missing
CREATE TABLE IF NOT EXISTS "Tenant" (
  "id" text PRIMARY KEY,
  "nome" text NOT NULL,
  "owner_id" text NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT NOW(),
  "updated_at" timestamp(3) NOT NULL DEFAULT NOW()
);

-- Backfill tenant_id for existing data
DO $$
DECLARE
  v_user_id text;
  v_tenant_id text;
BEGIN
  SELECT id INTO v_user_id FROM "User" ORDER BY created_at ASC LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'No users — skipping backfill';
    RETURN;
  END IF;

  -- Add nullable columns
  ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "LeadActivity" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "WhatsappInstance" ADD COLUMN IF NOT EXISTS "tenant_id" text;
  ALTER TABLE "WhatsappInstance" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
  ALTER TABLE "WebhookLog" ADD COLUMN IF NOT EXISTS "tenant_id" text;

  -- Create Tenant if missing
  v_tenant_id := gen_random_uuid()::text;
  IF NOT EXISTS (SELECT 1 FROM "Tenant" WHERE owner_id = v_user_id) THEN
    INSERT INTO "Tenant" (id, nome, owner_id, created_at, updated_at)
    VALUES (v_tenant_id, 'Default Workspace', v_user_id, NOW(), NOW());
  ELSE
    SELECT id INTO v_tenant_id FROM "Tenant" WHERE owner_id = v_user_id LIMIT 1;
  END IF;

  -- Backfill
  UPDATE "User"             SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "Pipeline"         SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "Stage"            SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "Lead"             SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "Message"          SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "LeadActivity"     SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE "WhatsappInstance" SET tenant_id = v_tenant_id, owner_user_id = v_user_id WHERE tenant_id IS NULL;

  RAISE NOTICE 'Backfilled tenant_id=%', v_tenant_id;
END $$;
