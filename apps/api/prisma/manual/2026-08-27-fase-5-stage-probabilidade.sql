-- Aplicar via psql -f ou statement a statement (todos idempotentes).

-- Fase 5 (dashboard financeira): probabilidade de fechamento por etapa (0-100).
-- null = default calculado por posicao no funil.
BEGIN;
ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "probabilidade" INTEGER;
COMMIT;
