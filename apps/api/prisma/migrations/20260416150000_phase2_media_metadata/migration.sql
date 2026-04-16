-- Phase 2 — Media metadata columns for images, videos, waveform peaks.
-- Additive-only migration. Safe to roll back via DROP COLUMN.
-- All columns nullable so legacy rows (no dimensions, no thumbnails) remain valid.

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "media_width"          INTEGER,
  ADD COLUMN IF NOT EXISTS "media_height"         INTEGER,
  ADD COLUMN IF NOT EXISTS "media_thumbnail_path" TEXT,
  ADD COLUMN IF NOT EXISTS "media_poster_path"    TEXT,
  ADD COLUMN IF NOT EXISTS "media_waveform_peaks" JSONB;
