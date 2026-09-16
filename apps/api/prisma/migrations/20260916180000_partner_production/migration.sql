-- CreateTable
CREATE TABLE "SalesPartner" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "joined_on" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "owner_id" TEXT,
    "lead_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerDailyProduction" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerDailyProduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerMonthlyGoal" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerMonthlyGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerProductionAudit" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "partner_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerProductionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesPartner_tenant_id_active_idx" ON "SalesPartner"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPartner_tenant_id_id_key" ON "SalesPartner"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPartner_tenant_id_lead_id_key" ON "SalesPartner"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "PartnerDailyProduction_tenant_id_date_idx" ON "PartnerDailyProduction"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerDailyProduction_tenant_id_partner_id_date_key" ON "PartnerDailyProduction"("tenant_id", "partner_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerMonthlyGoal_tenant_id_month_key" ON "PartnerMonthlyGoal"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "PartnerProductionAudit_tenant_id_created_at_idx" ON "PartnerProductionAudit"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "PartnerProductionAudit_tenant_id_partner_id_created_at_idx" ON "PartnerProductionAudit"("tenant_id", "partner_id", "created_at");

-- AddForeignKey
ALTER TABLE "SalesPartner" ADD CONSTRAINT "SalesPartner_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPartner" ADD CONSTRAINT "SalesPartner_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesPartner" ADD CONSTRAINT "SalesPartner_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDailyProduction" ADD CONSTRAINT "PartnerDailyProduction_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDailyProduction" ADD CONSTRAINT "PartnerDailyProduction_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "SalesPartner"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDailyProduction" ADD CONSTRAINT "PartnerDailyProduction_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerMonthlyGoal" ADD CONSTRAINT "PartnerMonthlyGoal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerMonthlyGoal" ADD CONSTRAINT "PartnerMonthlyGoal_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerProductionAudit" ADD CONSTRAINT "PartnerProductionAudit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerProductionAudit" ADD CONSTRAINT "PartnerProductionAudit_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "SalesPartner"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerProductionAudit" ADD CONSTRAINT "PartnerProductionAudit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Supabase public REST must not expose CRM partner data. Backend connects with
-- postgres/service-role privileges; no anon/authenticated policies are granted.
ALTER TABLE "SalesPartner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerDailyProduction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerMonthlyGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerProductionAudit" ENABLE ROW LEVEL SECURITY;
