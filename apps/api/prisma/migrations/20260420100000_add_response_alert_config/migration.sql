-- AddColumn response_alert_config to Stage
ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "response_alert_config" JSONB;
