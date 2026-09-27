-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('UNRESOLVED', 'RESOLVED_DATASET');

-- AlterTable
ALTER TABLE "check_call" ADD COLUMN     "resolution_source" TEXT,
ADD COLUMN     "resolution_status" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_lat" DECIMAL(9,6),
ADD COLUMN     "resolved_lng" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "load" ADD COLUMN     "current_location_lat" DECIMAL(9,6),
ADD COLUMN     "current_location_lng" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "stop" ADD COLUMN     "resolution_source" TEXT,
ADD COLUMN     "resolution_status" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_lat" DECIMAL(9,6),
ADD COLUMN     "resolved_lng" DECIMAL(9,6);

-- CreateTable
CREATE TABLE "geocode_cache" (
    "id" UUID NOT NULL,
    "lookup_key" TEXT NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "source" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "geocode_cache_lookup_key_key" ON "geocode_cache"("lookup_key");

