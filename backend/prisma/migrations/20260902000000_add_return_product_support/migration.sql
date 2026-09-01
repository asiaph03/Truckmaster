-- CreateEnum
CREATE TYPE "StopPurpose" AS ENUM ('STANDARD', 'RETURN');

-- AlterTable
ALTER TABLE "stop" ADD COLUMN "stop_purpose" "StopPurpose" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "load" ADD COLUMN "return_for_load_id" UUID;

-- CreateIndex
CREATE INDEX "load_organization_id_return_for_load_id_idx" ON "load"("organization_id", "return_for_load_id");

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_return_for_load_id_fkey" FOREIGN KEY ("return_for_load_id") REFERENCES "load"("id") ON DELETE SET NULL ON UPDATE CASCADE;
