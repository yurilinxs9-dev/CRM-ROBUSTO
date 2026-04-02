-- ============================================================
-- CRM WhatsApp — Supabase Setup
-- Executar em: https://hrebavqmbvsuhwbryvwg.supabase.co
-- SQL Editor → New Query → Cole tudo e execute
-- ============================================================

-- 1. Storage Buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-media', 'crm-media', false, 52428800,
  ARRAY[
    'audio/ogg', 'audio/opus', 'audio/webm', 'audio/mpeg', 'audio/mp4',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]
) ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
) ON CONFLICT (id) DO NOTHING;

-- 2. Storage Policies
-- O backend usa service_role_key → bypassa RLS automaticamente.
-- Estas policies são para segurança extra.

DROP POLICY IF EXISTS "service_role_all_crm_media" ON storage.objects;
CREATE POLICY "service_role_all_crm_media" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'crm-media')
  WITH CHECK (bucket_id = 'crm-media');

DROP POLICY IF EXISTS "public_read_avatars" ON storage.objects;
CREATE POLICY "public_read_avatars" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "service_role_write_avatars" ON storage.objects;
CREATE POLICY "service_role_write_avatars" ON storage.objects
  FOR ALL TO service_role
  WITH CHECK (bucket_id = 'avatars');

-- 3. Verificar buckets criados
SELECT id, name, public,
       pg_size_pretty(file_size_limit::bigint) as max_file_size
FROM storage.buckets
ORDER BY id;

-- ============================================================
-- EXECUTAR APÓS: npx prisma migrate deploy
-- (as tabelas abaixo só existem depois do migrate)
-- ============================================================

-- 4. Índices extras para performance (após migrate)
-- Execute este bloco separadamente após o prisma migrate

/*
-- Busca por telefone (sem pipeline)
CREATE INDEX IF NOT EXISTS idx_leads_telefone
  ON "Lead"(telefone);

-- Busca full-text no nome do lead
CREATE INDEX IF NOT EXISTS idx_leads_nome_trgm
  ON "Lead" USING gin(nome gin_trgm_ops);

-- Limpeza automática de webhook logs (requer extensão pg_cron)
-- Habilitar em: Dashboard → Database → Extensions → pg_cron
SELECT cron.schedule(
  'cleanup-webhook-logs',
  '0 2 * * *',
  $$DELETE FROM "WebhookLog" WHERE created_at < NOW() - INTERVAL '30 days'$$
);

SELECT cron.schedule(
  'cleanup-instance-logs',
  '0 3 * * *',
  $$DELETE FROM "InstanceLog" WHERE created_at < NOW() - INTERVAL '60 days'$$
);
*/

-- 5. Verificação final
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
