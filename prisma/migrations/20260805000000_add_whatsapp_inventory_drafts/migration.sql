-- CreateEnum
CREATE TYPE "WhatsAppDraftStatus" AS ENUM ('COLLECTING', 'AWAITING_CONFIRMATION', 'COMMITTED', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "whatsapp_configs"
  ADD COLUMN "ownerAlertPhone" TEXT,
  ADD COLUMN "saleAlertsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "whatsapp_messages"
  ADD COLUMN "intent" TEXT,
  ADD COLUMN "mediaType" TEXT,
  ADD COLUMN "mediaUrl" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_inventory_drafts" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "WhatsAppDraftStatus" NOT NULL DEFAULT 'COLLECTING',
  "sourceMessageSid" TEXT,
  "mediaUrl" TEXT,
  "extractedItems" JSONB NOT NULL,
  "missingFields" JSONB NOT NULL DEFAULT '[]',
  "supplierGuess" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_inventory_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_inventory_drafts_businessId_phone_status_idx"
  ON "whatsapp_inventory_drafts"("businessId", "phone", "status");

ALTER TABLE "whatsapp_inventory_drafts"
  ADD CONSTRAINT "whatsapp_inventory_drafts_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
