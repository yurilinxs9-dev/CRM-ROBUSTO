-- CreateTable
CREATE TABLE "PartnerTeamActivity" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "partner_id" TEXT,
    "lead_id" TEXT,
    "company_name" TEXT NOT NULL,
    "consultant_id" TEXT NOT NULL,
    "consultant_name" TEXT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "occurred_time" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerTeamActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerConsultantGoal" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "consultant_id" TEXT NOT NULL,
    "consultant_name" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerConsultantGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerTeamActivity_tenant_id_occurred_on_consultant_id_idx" ON "PartnerTeamActivity"("tenant_id", "occurred_on", "consultant_id");

-- CreateIndex
CREATE INDEX "PartnerTeamActivity_tenant_id_subject_key_idx" ON "PartnerTeamActivity"("tenant_id", "subject_key");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTeamActivity_tenant_id_request_id_key" ON "PartnerTeamActivity"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTeamActivity_tenant_id_dedupe_key_key" ON "PartnerTeamActivity"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "PartnerConsultantGoal_tenant_id_month_idx" ON "PartnerConsultantGoal"("tenant_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerConsultantGoal_tenant_id_consultant_id_month_key" ON "PartnerConsultantGoal"("tenant_id", "consultant_id", "month");

-- AddForeignKey
ALTER TABLE "PartnerTeamActivity" ADD CONSTRAINT "PartnerTeamActivity_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "SalesPartner"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PartnerTeamActivity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerConsultantGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerTeamActivity" ADD CONSTRAINT "PartnerTeamActivity_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');
ALTER TABLE "PartnerConsultantGoal" ADD CONSTRAINT "PartnerConsultantGoal_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');
ALTER TABLE "PartnerTeamActivity" ADD CONSTRAINT "PartnerTeamActivity_kind_check" CHECK ("kind" IN ('meeting','registration','training'));
ALTER TABLE "PartnerTeamActivity" ADD CONSTRAINT "PartnerTeamActivity_registration_check" CHECK ("kind" <> 'registration' OR ("partner_id" IS NOT NULL AND "occurred_time" = '00:00'));
ALTER TABLE "PartnerTeamActivity" ADD CONSTRAINT "PartnerTeamActivity_time_check" CHECK ("occurred_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "PartnerConsultantGoal" ADD CONSTRAINT "PartnerConsultantGoal_target_check" CHECK ("target" >= 0 AND "target" <= 100000);