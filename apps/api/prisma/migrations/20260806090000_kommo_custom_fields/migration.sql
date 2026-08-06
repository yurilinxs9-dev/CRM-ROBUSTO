-- Campos personalizados com paridade Kommo: escopos (lead/contato/empresa),
-- grupos de campo, campos nativos na mesma lista, e as entidades Contact,
-- Company e LeadContact.
--
-- ADITIVO. A tabela dos leads NÃO é alterada: o vínculo mora em "LeadContact",
-- tabela nova cuja FK aponta para ela. Nenhum lead existente é lido, escrito ou
-- migrado — ver docs/plans/2026-08-05-campos-personalizados-kommo.md.
--
-- Aplicar com:  node scripts/apply-kommo-fields.mjs   (cwd = apps/api)
--
-- As linhas "-- @@SPLIT" separam os statements para o script aplicador. Elas são
-- comentários SQL, então este arquivo continua válido para colar no SQL Editor.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FieldScope') THEN
    CREATE TYPE "FieldScope" AS ENUM ('LEAD', 'CONTATO', 'EMPRESA');
  END IF;
END
$$;

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "CustomFieldGroup" (
  "id"         TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "escopo"     "FieldScope" NOT NULL,
  "nome"       TEXT NOT NULL,
  "ordem"      INTEGER NOT NULL DEFAULT 0,
  "is_system"  BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomFieldGroup_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "CustomFieldGroup_tenant_id_escopo_ordem_idx"
  ON "CustomFieldGroup"("tenant_id", "escopo", "ordem");

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldGroup_tenant_id_escopo_nome_key"
  ON "CustomFieldGroup"("tenant_id", "escopo", "nome");

-- @@SPLIT

-- Colunas novas com DEFAULT não-volátil → PostgreSQL 11+ não reescreve a tabela.
-- As linhas existentes caem em escopo 'LEAD', que é exatamente onde já estavam.
ALTER TABLE "CustomFieldDef"
  ADD COLUMN IF NOT EXISTS "escopo"     "FieldScope" NOT NULL DEFAULT 'LEAD',
  ADD COLUMN IF NOT EXISTS "group_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "native_key" TEXT,
  ADD COLUMN IF NOT EXISTS "api_only"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "visible"    BOOLEAN NOT NULL DEFAULT true;

-- @@SPLIT

-- Unicidade passa a considerar o escopo: um "E-mail" do contato pode coexistir
-- com um "E-mail" do lead. Seguro para os dados atuais — todos viram 'LEAD',
-- então (tenant_id,'LEAD',key) é único sempre que (tenant_id,key) era.
DROP INDEX IF EXISTS "CustomFieldDef_tenant_id_key_key";

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_tenant_id_escopo_key_key"
  ON "CustomFieldDef"("tenant_id", "escopo", "key");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "CustomFieldDef_tenant_id_escopo_ordem_idx"
  ON "CustomFieldDef"("tenant_id", "escopo", "ordem");

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "Company" (
  "id"           TEXT NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "nome"         TEXT NOT NULL,
  "telefone"     TEXT,
  "email"        TEXT,
  "site"         TEXT,
  "endereco"     TEXT,
  "dados_custom" JSONB DEFAULT '{}',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "Company_tenant_id_idx" ON "Company"("tenant_id");

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "Contact" (
  "id"           TEXT NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "nome"         TEXT NOT NULL,
  "telefone"     TEXT,
  "email"        TEXT,
  "cargo"        TEXT,
  "company_id"   TEXT,
  "dados_custom" JSONB DEFAULT '{}',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "Contact_tenant_id_idx" ON "Contact"("tenant_id");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "Contact_tenant_id_telefone_idx" ON "Contact"("tenant_id", "telefone");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "Contact_company_id_idx" ON "Contact"("company_id");

-- @@SPLIT

-- A FK referencia a tabela de leads, mas a DDL é toda em "LeadContact". O
-- PostgreSQL pega um lock breve na referenciada para instalar o trigger da
-- constraint; como esta tabela nasce vazia, a validação é imediata e não há
-- rewrite do outro lado.
CREATE TABLE IF NOT EXISTS "LeadContact" (
  "lead_id"      TEXT NOT NULL,
  "contact_id"   TEXT NOT NULL,
  "is_principal" BOOLEAN NOT NULL DEFAULT false,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeadContact_pkey" PRIMARY KEY ("lead_id", "contact_id")
);

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "LeadContact_contact_id_idx" ON "LeadContact"("contact_id");

-- @@SPLIT

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomFieldGroup_tenant_id_fkey') THEN
    ALTER TABLE "CustomFieldGroup" ADD CONSTRAINT "CustomFieldGroup_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomFieldDef_group_id_fkey') THEN
    ALTER TABLE "CustomFieldDef" ADD CONSTRAINT "CustomFieldDef_group_id_fkey"
      FOREIGN KEY ("group_id") REFERENCES "CustomFieldGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Company_tenant_id_fkey') THEN
    ALTER TABLE "Company" ADD CONSTRAINT "Company_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Contact_tenant_id_fkey') THEN
    ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Contact_company_id_fkey') THEN
    ALTER TABLE "Contact" ADD CONSTRAINT "Contact_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadContact_lead_id_fkey') THEN
    ALTER TABLE "LeadContact" ADD CONSTRAINT "LeadContact_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LeadContact_contact_id_fkey') THEN
    ALTER TABLE "LeadContact" ADD CONSTRAINT "LeadContact_contact_id_fkey"
      FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
