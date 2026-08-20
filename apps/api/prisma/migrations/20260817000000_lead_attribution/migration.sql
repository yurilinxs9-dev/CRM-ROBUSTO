-- Atribuição de origem do lead (de onde ele veio: anúncio, busca, orgânico).
--
-- ADITIVO E SÓ. Quatro tabelas novas e um enum novo. NENHUM ALTER em tabela
-- existente: a única FK aponta PARA "Lead", e mora em "LeadAttribution" — mesmo
-- padrão de "LeadContact" (20260806090000_kommo_custom_fields).
-- Ver docs/specs/atribuicao-de-origem.md.
--
-- Aplicar com:  node scripts/apply-attribution.mjs   (cwd = apps/api)
--
-- As linhas "-- @@SPLIT" separam os statements para o script aplicador. Elas são
-- comentários SQL, então este arquivo continua válido para colar no SQL Editor.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttributionChannel') THEN
    CREATE TYPE "AttributionChannel" AS ENUM (
      'META_ADS',
      'GOOGLE_ADS',
      'GOOGLE_ORGANIC',
      'SOCIAL_ORGANIC',
      'REFERRAL',
      'DIRECT',
      'INDICACAO',
      'UNKNOWN'
    );
  END IF;
END
$$;

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "LeadAttribution" (
  "id"            TEXT NOT NULL,
  "lead_id"       TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "channel"       "AttributionChannel" NOT NULL,
  "paid"          BOOLEAN NOT NULL,
  "source"        TEXT,
  "campaign_id"   TEXT,
  "adgroup_id"    TEXT,
  "creative_id"   TEXT,
  "campaign_name" TEXT,
  "keyword"       TEXT,
  "match_type"    TEXT,
  "network"       TEXT,
  "device"        TEXT,
  "gclid"         TEXT,
  "wbraid"        TEXT,
  "gbraid"        TEXT,
  "fbclid"        TEXT,
  "ctwa_clid"     TEXT,
  "utm_source"    TEXT,
  "utm_medium"    TEXT,
  "utm_campaign"  TEXT,
  "utm_term"      TEXT,
  "utm_content"   TEXT,
  "ad_id"         TEXT,
  "ad_title"      TEXT,
  "ad_url"        TEXT,
  "landing_url"   TEXT,
  "referrer"      TEXT,
  "clicked_at"    TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeadAttribution_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "LeadAttribution_lead_id_key"
  ON "LeadAttribution"("lead_id");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "LeadAttribution_tenant_id_channel_idx"
  ON "LeadAttribution"("tenant_id", "channel");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "LeadAttribution_tenant_id_created_at_idx"
  ON "LeadAttribution"("tenant_id", "created_at");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "LeadAttribution_tenant_id_source_campaign_id_idx"
  ON "LeadAttribution"("tenant_id", "source", "campaign_id");

-- @@SPLIT

-- A FK vive na tabela NOVA. "Lead" não é alterada: ganha só a referência.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LeadAttribution_lead_id_fkey'
  ) THEN
    ALTER TABLE "LeadAttribution"
      ADD CONSTRAINT "LeadAttribution_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "Lead"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "TrackedClick" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "clicked_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrackedClick_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "TrackedClick_tenant_id_code_key"
  ON "TrackedClick"("tenant_id", "code");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "TrackedClick_created_at_idx"
  ON "TrackedClick"("created_at");

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "AdCampaignLabel" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "source"      TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdCampaignLabel_pkey" PRIMARY KEY ("id")
);

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "AdCampaignLabel_tenant_id_source_campaign_id_key"
  ON "AdCampaignLabel"("tenant_id", "source", "campaign_id");

-- @@SPLIT

CREATE INDEX IF NOT EXISTS "AdCampaignLabel_tenant_id_idx"
  ON "AdCampaignLabel"("tenant_id");

-- @@SPLIT

CREATE TABLE IF NOT EXISTS "TenantSiteConfig" (
  "tenant_id"  TEXT NOT NULL,
  "site_token" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TenantSiteConfig_pkey" PRIMARY KEY ("tenant_id")
);

-- @@SPLIT

CREATE UNIQUE INDEX IF NOT EXISTS "TenantSiteConfig_site_token_key"
  ON "TenantSiteConfig"("site_token");
