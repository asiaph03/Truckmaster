-- CreateEnum
CREATE TYPE "AttentionType" AS ENUM ('PICKUP_MISSED', 'DELIVERY_MISSED', 'ETA_AFTER_APPOINTMENT', 'APPOINTMENT_IMMINENT_NO_CHECK_CALL', 'STALE_LOCATION', 'UNASSIGNED_DISPATCHER', 'STUCK_CARRIER_SOURCING', 'CHECK_CALL_OVERDUE', 'STUCK_LOAD_STATUS', 'MISSING_POD', 'UNRESOLVED_LOCATION', 'MISSING_REQUIRED_DOCUMENT', 'CHECK_CALL_DUE_SOON', 'APPOINTMENT_CHANGED', 'MANUAL_RISK_FLAG');

-- CreateEnum
CREATE TYPE "AttentionSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'INFO');

-- CreateEnum
CREATE TYPE "AttentionStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateTable
CREATE TABLE "attention_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "type" "AttentionType" NOT NULL,
    "severity" "AttentionSeverity" NOT NULL,
    "status" "AttentionStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "impact" TEXT,
    "suggested_actions" JSONB NOT NULL,
    "metadata" JSONB,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "attention_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attention_item_organization_id_status_severity_idx" ON "attention_item"("organization_id", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "attention_item_organization_id_load_id_type_key" ON "attention_item"("organization_id", "load_id", "type");

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

