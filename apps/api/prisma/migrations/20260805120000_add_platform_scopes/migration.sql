-- Escopos do admin de plataforma. Aditivo: só cria coluna nova.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "platform_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: quem já era admin de plataforma vira master, senão perde o painel.
UPDATE "User"
   SET "platform_scopes" = ARRAY['*']
 WHERE "is_platform_admin" = true
   AND cardinality("platform_scopes") = 0;
