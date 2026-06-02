-- Notificação: separa "Seus leads" de "Equipe" no sino.
-- responsavel_nome NULL = lead do próprio destinatário; preenchido = lead de
-- operador (super-admin/gerente em supervisão).
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "responsavel_nome" TEXT;
