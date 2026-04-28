-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "visible_to_user_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_visible_to_user_id_idx" ON "Message"("visible_to_user_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Message_visible_to_user_id_fkey') THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_visible_to_user_id_fkey" FOREIGN KEY ("visible_to_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
