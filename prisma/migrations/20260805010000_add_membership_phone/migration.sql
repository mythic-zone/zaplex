-- AlterTable
ALTER TABLE "memberships" ADD COLUMN "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "memberships_phone_key" ON "memberships"("phone");
