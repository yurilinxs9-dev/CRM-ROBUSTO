-- AlterTable
ALTER TABLE "Message" ADD COLUMN "media_archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Message_media_archived_created_at_idx" ON "Message"("media_archived", "created_at");
