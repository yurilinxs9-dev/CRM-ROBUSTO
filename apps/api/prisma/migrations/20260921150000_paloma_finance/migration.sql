-- CreateTable
CREATE TABLE "FinanceAccess" (
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccess_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "FinanceSession" (
    "token_hash" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceSession_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "FinanceRule" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "total_bps" INTEGER NOT NULL,
    "distribution" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSale" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_version" INTEGER,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "closed_on" DATE NOT NULL,
    "rule_id" TEXT NOT NULL,
    "commission_total" DECIMAL(16,2) NOT NULL,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceInstallment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "due_overridden" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(16,2) NOT NULL,
    "received_on" DATE,
    "received_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAudit" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceAccess_user_id_key" ON "FinanceAccess"("user_id");

-- CreateIndex
CREATE INDEX "FinanceSession_tenant_id_user_id_idx" ON "FinanceSession"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "FinanceSession_expires_at_idx" ON "FinanceSession"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceRule_tenant_id_version_key" ON "FinanceRule"("tenant_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceRule_tenant_id_id_key" ON "FinanceRule"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "FinanceSale_tenant_id_closed_on_idx" ON "FinanceSale"("tenant_id", "closed_on");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSale_tenant_id_source_type_source_key_key" ON "FinanceSale"("tenant_id", "source_type", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSale_tenant_id_id_key" ON "FinanceSale"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "FinanceInstallment_tenant_id_due_on_idx" ON "FinanceInstallment"("tenant_id", "due_on");

-- CreateIndex
CREATE INDEX "FinanceInstallment_tenant_id_received_on_idx" ON "FinanceInstallment"("tenant_id", "received_on");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceInstallment_tenant_id_sale_id_number_key" ON "FinanceInstallment"("tenant_id", "sale_id", "number");

-- CreateIndex
CREATE INDEX "FinanceAudit_tenant_id_created_at_idx" ON "FinanceAudit"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "FinanceSale" ADD CONSTRAINT "FinanceSale_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "FinanceRule"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceInstallment" ADD CONSTRAINT "FinanceInstallment_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "FinanceSale"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "FinanceAccess" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceSession" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceRule" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceSale" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceInstallment" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceAudit" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "FinanceAccess" ADD CONSTRAINT "FinanceAccess_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceSession" ADD CONSTRAINT "FinanceSession_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceRule" ADD CONSTRAINT "FinanceRule_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceSale" ADD CONSTRAINT "FinanceSale_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceInstallment" ADD CONSTRAINT "FinanceInstallment_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceAudit" ADD CONSTRAINT "FinanceAudit_tenant_scope" CHECK ("tenant_id" = 'a44772ed-1382-4400-84fc-3fa350e23e42');

ALTER TABLE "FinanceAccess" ADD CONSTRAINT "FinanceAccess_user_scope" CHECK ("user_id" = '4f72be61-f5a6-4222-bbfd-074c4da31b87');

ALTER TABLE "FinanceSession" ADD CONSTRAINT "FinanceSession_user_scope" CHECK ("user_id" = '4f72be61-f5a6-4222-bbfd-074c4da31b87');

ALTER TABLE "FinanceAudit" ADD CONSTRAINT "FinanceAudit_user_scope" CHECK ("user_id" = '4f72be61-f5a6-4222-bbfd-074c4da31b87');

ALTER TABLE "FinanceInstallment" ADD CONSTRAINT "FinanceInstallment_received_pair" CHECK (("received_on" IS NULL AND "received_by" IS NULL) OR ("received_on" IS NOT NULL AND "received_by" = '4f72be61-f5a6-4222-bbfd-074c4da31b87'));
ALTER TABLE "FinanceInstallment" ADD CONSTRAINT "FinanceInstallment_amount_nonnegative" CHECK ("amount" >= 0);
ALTER TABLE "FinanceSale" ADD CONSTRAINT "FinanceSale_amount_nonnegative" CHECK ("amount" >= 0 AND "commission_total" >= 0);
