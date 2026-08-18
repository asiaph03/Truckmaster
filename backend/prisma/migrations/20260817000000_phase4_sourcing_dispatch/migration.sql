-- CreateEnum
CREATE TYPE "SourcingAttemptOutcome" AS ENUM ('ASSIGNED', 'DECLINED', 'NO_RESPONSE', 'QUOTED', 'REJECTED_AFTER_ASSIGNMENT');

-- CreateEnum
CREATE TYPE "CheckCallOnTimeStatus" AS ENUM ('ON_TIME', 'LATE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "carrier_sourcing_attempt" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "carrier_rate" DECIMAL(12,2),
    "outcome" "SourcingAttemptOutcome" NOT NULL,
    "rejection_reason" TEXT,
    "logged_by_user_id" UUID NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_sourcing_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_record" (
    "load_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "driver_name" TEXT NOT NULL,
    "driver_phone" TEXT NOT NULL,
    "truck_number" TEXT NOT NULL,
    "trailer_number" TEXT NOT NULL,
    "source_driver_id" UUID,
    "source_truck_id" UUID,
    "source_trailer_id" UUID,
    "dispatched_by_user_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_record_pkey" PRIMARY KEY ("load_id")
);

-- CreateTable
CREATE TABLE "check_call" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "logged_by_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "contact_method" TEXT NOT NULL,
    "person_contacted" TEXT NOT NULL,
    "location_city" TEXT,
    "location_state" TEXT,
    "location_zip" TEXT,
    "eta" TIMESTAMP(3),
    "on_time_status" "CheckCallOnTimeStatus" NOT NULL,
    "notes" TEXT,

    CONSTRAINT "check_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carrier_sourcing_attempt_organization_id_load_id_idx" ON "carrier_sourcing_attempt"("organization_id", "load_id");

-- CreateIndex
CREATE INDEX "carrier_sourcing_attempt_organization_id_carrier_id_idx" ON "carrier_sourcing_attempt"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "dispatch_record_organization_id_idx" ON "dispatch_record"("organization_id");

-- CreateIndex
CREATE INDEX "check_call_organization_id_load_id_idx" ON "check_call"("organization_id", "load_id");

-- AddForeignKey
ALTER TABLE "carrier_sourcing_attempt" ADD CONSTRAINT "carrier_sourcing_attempt_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_sourcing_attempt" ADD CONSTRAINT "carrier_sourcing_attempt_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_sourcing_attempt" ADD CONSTRAINT "carrier_sourcing_attempt_logged_by_user_id_fkey" FOREIGN KEY ("logged_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_record" ADD CONSTRAINT "dispatch_record_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_record" ADD CONSTRAINT "dispatch_record_source_driver_id_fkey" FOREIGN KEY ("source_driver_id") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_record" ADD CONSTRAINT "dispatch_record_source_truck_id_fkey" FOREIGN KEY ("source_truck_id") REFERENCES "truck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_record" ADD CONSTRAINT "dispatch_record_source_trailer_id_fkey" FOREIGN KEY ("source_trailer_id") REFERENCES "trailer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_record" ADD CONSTRAINT "dispatch_record_dispatched_by_user_id_fkey" FOREIGN KEY ("dispatched_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_call" ADD CONSTRAINT "check_call_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_call" ADD CONSTRAINT "check_call_logged_by_user_id_fkey" FOREIGN KEY ("logged_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

