-- Multi-tenant refactor: introduce Tenant, drop Team, add tenant_id everywhere.

-- 1. Create Tenant table (FK to User added later, after backfill)
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Tenant_owner_id_idx" ON "Tenant"("owner_id");

-- 2. Drop FK + column team_id from User, drop Team
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_team_id_fkey";
ALTER TABLE "User" DROP COLUMN IF EXISTS "team_id";
DROP TABLE IF EXISTS "Team";

-- 3. Add tenant_id (nullable for now) + new columns
ALTER TABLE "User"             ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Pipeline"         ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Stage"            ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Lead"             ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Message"          ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "LeadActivity"     ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "WhatsappInstance" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "WhatsappInstance" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "WhatsappInstance" ADD COLUMN "updated_at" TIMESTAMP(3);
ALTER TABLE "UserInstance"     ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "InstanceLog"      ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Tag"              ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "LeadTag"          ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "QuickReply"       ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Notification"     ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "Task"             ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "WebhookLog"       ADD COLUMN "tenant_id" TEXT;

-- 4. Backfill: one Tenant per existing User (owned by that user)
DO $$
DECLARE
    u RECORD;
    new_tenant_id TEXT;
    first_tenant_id TEXT;
    first_user_id TEXT;
BEGIN
    FOR u IN SELECT id, nome FROM "User" ORDER BY created_at ASC LOOP
        new_tenant_id := gen_random_uuid()::text;
        INSERT INTO "Tenant" (id, nome, owner_id, created_at, updated_at)
        VALUES (new_tenant_id, COALESCE(u.nome, 'Workspace') || ' workspace', u.id, NOW(), NOW());
        UPDATE "User" SET tenant_id = new_tenant_id WHERE id = u.id;
        IF first_tenant_id IS NULL THEN
            first_tenant_id := new_tenant_id;
            first_user_id := u.id;
        END IF;
    END LOOP;

    -- If there are no users, create a synthetic system tenant placeholder
    IF first_tenant_id IS NULL THEN
        -- Nothing to backfill; remaining UPDATEs will be no-ops.
        RETURN;
    END IF;

    -- Tables tied to a user via responsavel_id / user_id / sent_by_user_id
    UPDATE "Lead" l         SET tenant_id = u.tenant_id FROM "User" u WHERE l.responsavel_id = u.id AND l.tenant_id IS NULL;
    UPDATE "LeadActivity" a SET tenant_id = u.tenant_id FROM "User" u WHERE a.user_id = u.id AND a.tenant_id IS NULL;
    UPDATE "QuickReply" q   SET tenant_id = u.tenant_id FROM "User" u WHERE q.user_id = u.id AND q.tenant_id IS NULL;
    UPDATE "Notification" n SET tenant_id = u.tenant_id FROM "User" u WHERE n.user_id = u.id AND n.tenant_id IS NULL;
    UPDATE "Task" t         SET tenant_id = u.tenant_id FROM "User" u WHERE t.responsavel_id = u.id AND t.tenant_id IS NULL;
    UPDATE "UserInstance" ui SET tenant_id = u.tenant_id FROM "User" u WHERE ui.user_id = u.id AND ui.tenant_id IS NULL;

    -- Message via lead
    UPDATE "Message" m SET tenant_id = l.tenant_id FROM "Lead" l WHERE m.lead_id = l.id AND m.tenant_id IS NULL;

    -- LeadActivity fallback via lead
    UPDATE "LeadActivity" a SET tenant_id = l.tenant_id FROM "Lead" l WHERE a.lead_id = l.id AND a.tenant_id IS NULL;

    -- LeadTag via lead
    UPDATE "LeadTag" lt SET tenant_id = l.tenant_id FROM "Lead" l WHERE lt.lead_id = l.id AND lt.tenant_id IS NULL;

    -- Stage via pipeline (after Pipeline is set below) — handled later

    -- Globally-owned tables: assign to FIRST tenant
    UPDATE "Pipeline"          SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Stage"             SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Tag"               SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "WhatsappInstance"  SET tenant_id = first_tenant_id, owner_user_id = first_user_id WHERE tenant_id IS NULL;
    UPDATE "InstanceLog"       SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "WebhookLog"        SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "LeadTag"           SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Lead"              SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Message"           SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "LeadActivity"      SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "QuickReply"        SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Notification"      SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "Task"              SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
    UPDATE "UserInstance"      SET tenant_id = first_tenant_id WHERE tenant_id IS NULL;
END $$;

-- WhatsappInstance.updated_at backfill
UPDATE "WhatsappInstance" SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL;

-- 5. SET NOT NULL
ALTER TABLE "User"             ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Pipeline"         ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Stage"            ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Lead"             ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Message"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "LeadActivity"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "WhatsappInstance" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "WhatsappInstance" ALTER COLUMN "owner_user_id" SET NOT NULL;
ALTER TABLE "WhatsappInstance" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "UserInstance"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "InstanceLog"      ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Tag"              ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "LeadTag"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "QuickReply"       ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Notification"     ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "Task"             ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "WebhookLog"       ALTER COLUMN "tenant_id" SET NOT NULL;

-- 6. Foreign keys
ALTER TABLE "Tenant"           ADD CONSTRAINT "Tenant_owner_id_fkey"           FOREIGN KEY ("owner_id")      REFERENCES "User"("id")   ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User"             ADD CONSTRAINT "User_tenant_id_fkey"            FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Pipeline"         ADD CONSTRAINT "Pipeline_tenant_id_fkey"        FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Stage"            ADD CONSTRAINT "Stage_tenant_id_fkey"           FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead"             ADD CONSTRAINT "Lead_tenant_id_fkey"            FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message"          ADD CONSTRAINT "Message_tenant_id_fkey"         FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeadActivity"     ADD CONSTRAINT "LeadActivity_tenant_id_fkey"    FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsappInstance" ADD CONSTRAINT "WhatsappInstance_tenant_id_fkey" FOREIGN KEY ("tenant_id")    REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsappInstance" ADD CONSTRAINT "WhatsappInstance_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserInstance"     ADD CONSTRAINT "UserInstance_tenant_id_fkey"    FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InstanceLog"      ADD CONSTRAINT "InstanceLog_tenant_id_fkey"     FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tag"              ADD CONSTRAINT "Tag_tenant_id_fkey"             FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeadTag"          ADD CONSTRAINT "LeadTag_tenant_id_fkey"         FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickReply"       ADD CONSTRAINT "QuickReply_tenant_id_fkey"      FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification"     ADD CONSTRAINT "Notification_tenant_id_fkey"    FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task"             ADD CONSTRAINT "Task_tenant_id_fkey"            FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookLog"       ADD CONSTRAINT "WebhookLog_tenant_id_fkey"      FOREIGN KEY ("tenant_id")     REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Tag uniqueness migrate: drop global Tag_nome_key, add composite
ALTER TABLE "Tag" DROP CONSTRAINT IF EXISTS "Tag_nome_key";
DROP INDEX IF EXISTS "Tag_nome_key";
CREATE UNIQUE INDEX "Tag_tenant_id_nome_key" ON "Tag"("tenant_id", "nome");

-- Pipeline composite uniqueness (no prior unique on nome existed)
CREATE UNIQUE INDEX "Pipeline_tenant_id_nome_key" ON "Pipeline"("tenant_id", "nome");

-- 8. Indexes
CREATE INDEX "User_tenant_id_idx"             ON "User"("tenant_id");
CREATE INDEX "Pipeline_tenant_id_idx"         ON "Pipeline"("tenant_id");
CREATE INDEX "Stage_tenant_id_idx"            ON "Stage"("tenant_id");
CREATE INDEX "Lead_tenant_id_idx"             ON "Lead"("tenant_id");
CREATE INDEX "Message_tenant_id_idx"          ON "Message"("tenant_id");
CREATE INDEX "Message_status_created_at_idx"  ON "Message"("status", "created_at");
CREATE INDEX "LeadActivity_tenant_id_idx"     ON "LeadActivity"("tenant_id");
CREATE INDEX "WhatsappInstance_tenant_id_idx" ON "WhatsappInstance"("tenant_id");
CREATE INDEX "UserInstance_tenant_id_idx"     ON "UserInstance"("tenant_id");
CREATE INDEX "InstanceLog_tenant_id_idx"      ON "InstanceLog"("tenant_id");
CREATE INDEX "Tag_tenant_id_idx"              ON "Tag"("tenant_id");
CREATE INDEX "LeadTag_tenant_id_idx"          ON "LeadTag"("tenant_id");
CREATE INDEX "QuickReply_tenant_id_idx"       ON "QuickReply"("tenant_id");
CREATE INDEX "Notification_tenant_id_idx"     ON "Notification"("tenant_id");
CREATE INDEX "Task_tenant_id_idx"             ON "Task"("tenant_id");
CREATE INDEX "Task_scheduled_at_idx"          ON "Task"("scheduled_at");
CREATE INDEX "WebhookLog_tenant_id_idx"       ON "WebhookLog"("tenant_id");
