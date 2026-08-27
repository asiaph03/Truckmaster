-- CreateEnum
CREATE TYPE "DocumentGenerationStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "document" ADD COLUMN "generation_status" "DocumentGenerationStatus";
