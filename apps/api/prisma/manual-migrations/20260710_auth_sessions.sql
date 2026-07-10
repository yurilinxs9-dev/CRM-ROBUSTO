-- 20260710_auth_sessions — RefreshToken + PasswordResetToken
-- Aplicar manualmente no Supabase (histórico de migrations está poluído — ver CLAUDE.md).
-- Só objetos novos; não toca em nada existente. Idempotente via IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"          TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "family_id"   TEXT NOT NULL,
  "token_hash"  TEXT NOT NULL,
  "remember"    BOOLEAN NOT NULL DEFAULT false,
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "revoked_at"  TIMESTAMP(3),
  "replaced_by" TEXT,
  "ip"          TEXT,
  "user_agent"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_token_hash_key" ON "RefreshToken"("token_hash");
CREATE INDEX IF NOT EXISTS "RefreshToken_user_id_idx" ON "RefreshToken"("user_id");
CREATE INDEX IF NOT EXISTS "RefreshToken_family_id_idx" ON "RefreshToken"("family_id");
CREATE INDEX IF NOT EXISTS "RefreshToken_expires_at_idx" ON "RefreshToken"("expires_at");

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PasswordResetToken_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_token_hash_key" ON "PasswordResetToken"("token_hash");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_user_id_idx" ON "PasswordResetToken"("user_id");

COMMIT;
