-- CreateTable
CREATE TABLE "PLSale" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "seller_name" TEXT NOT NULL,
    "contract_number" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "sold_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PLSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PLMonthlyGoal" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "owner_key" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PLMonthlyGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PLSalesAudit" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PLSalesAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PLSale_tenant_id_sold_on_seller_id_idx" ON "PLSale"("tenant_id", "sold_on", "seller_id");

-- CreateIndex
CREATE INDEX "PLSale_tenant_id_lead_id_idx" ON "PLSale"("tenant_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "PLSale_tenant_id_contract_number_key" ON "PLSale"("tenant_id", "contract_number");

-- CreateIndex
CREATE UNIQUE INDEX "PLMonthlyGoal_tenant_id_month_owner_key_key" ON "PLMonthlyGoal"("tenant_id", "month", "owner_key");

-- CreateIndex
CREATE INDEX "PLSalesAudit_tenant_id_created_at_idx" ON "PLSalesAudit"("tenant_id", "created_at");


-- These are new objects only. Existing CRM/partner objects are unchanged.
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_amount_positive" CHECK (amount > 0);
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_status_valid" CHECK (status IN ('ACTIVE','CANCELLED'));
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_version_positive" CHECK (version > 0);
ALTER TABLE "PLMonthlyGoal" ADD CONSTRAINT "PLMonthlyGoal_amount_nonnegative" CHECK (amount >= 0);
ALTER TABLE "PLMonthlyGoal" ADD CONSTRAINT "PLMonthlyGoal_version_positive" CHECK (version > 0);
ALTER TABLE "PLMonthlyGoal" ADD CONSTRAINT "PLMonthlyGoal_month_valid" CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_tenant_fkey" FOREIGN KEY (tenant_id) REFERENCES "Tenant"(id) ON DELETE RESTRICT;
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_lead_fkey" FOREIGN KEY (lead_id) REFERENCES "Lead"(id) ON DELETE RESTRICT;
ALTER TABLE "PLSale" ADD CONSTRAINT "PLSale_seller_fkey" FOREIGN KEY (seller_id) REFERENCES "User"(id) ON DELETE RESTRICT;
ALTER TABLE "PLMonthlyGoal" ADD CONSTRAINT "PLMonthlyGoal_tenant_fkey" FOREIGN KEY (tenant_id) REFERENCES "Tenant"(id) ON DELETE RESTRICT;
ALTER TABLE "PLSalesAudit" ADD CONSTRAINT "PLSalesAudit_tenant_fkey" FOREIGN KEY (tenant_id) REFERENCES "Tenant"(id) ON DELETE RESTRICT;
ALTER TABLE "PLSale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PLMonthlyGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PLSalesAudit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "PLSale", "PLMonthlyGoal", "PLSalesAudit" FROM anon, authenticated;
