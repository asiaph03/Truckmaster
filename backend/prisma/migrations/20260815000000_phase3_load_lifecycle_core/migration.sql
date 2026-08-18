-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('MANUAL', 'RATE_AGREEMENT', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "QuoteStopType" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('QUOTE', 'DIRECT');

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('BOOKED', 'CARRIER_SOURCING', 'CARRIER_ASSIGNED', 'RATE_CONFIRMATION', 'DISPATCHED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PodStatus" AS ENUM ('NOT_RECEIVED', 'PARTIAL', 'COMPLETE');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('NORMAL', 'AT_RISK', 'DELAYED');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('PICKUP', 'DELIVERY', 'OTHER');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED');

-- CreateTable
CREATE TABLE "quote" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "equipment_type" "EquipmentType" NOT NULL,
    "customer_rate" DECIMAL(12,2) NOT NULL,
    "rate_source" "RateSource" NOT NULL,
    "rate_agreement_id" UUID,
    "status" "QuoteStatus" NOT NULL DEFAULT 'OPEN',
    "loss_reason" TEXT,
    "expiration_date" DATE NOT NULL,
    "resulting_load_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_stop" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stop_type" "QuoteStopType" NOT NULL,
    "address_city" TEXT NOT NULL,
    "address_state" TEXT NOT NULL,
    "address_zip" TEXT NOT NULL,
    "appointment_notes" TEXT,

    CONSTRAINT "quote_stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "booking_source" "BookingSource" NOT NULL,
    "quote_id" UUID,
    "status" "LoadStatus" NOT NULL DEFAULT 'BOOKED',
    "equipment_type" "EquipmentType" NOT NULL,
    "customer_rate" DECIMAL(12,2) NOT NULL,
    "rate_source" "RateSource" NOT NULL,
    "rate_agreement_id" UUID,
    "customer_po_number" TEXT,
    "bol_number" TEXT,
    "pickup_number" TEXT,
    "customer_reference_number" TEXT,
    "assigned_carrier_id" UUID,
    "carrier_rate" DECIMAL(12,2),
    "assigned_dispatcher_id" UUID,
    "pod_status" "PodStatus" NOT NULL DEFAULT 'NOT_RECEIVED',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'NORMAL',
    "risk_reason" TEXT,
    "current_location_city" TEXT,
    "current_location_state" TEXT,
    "current_location_zip" TEXT,
    "current_location_description" TEXT,
    "current_location_updated_at" TIMESTAMP(3),
    "current_eta" TIMESTAMP(3),
    "invoiced" BOOLEAN NOT NULL DEFAULT false,
    "posted_externally" BOOLEAN,
    "posting_platform" TEXT,
    "posting_status" TEXT,
    "posting_notes" TEXT,
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stop" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stop_type" "StopType" NOT NULL,
    "customer_location_id" UUID,
    "address_line1" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "appointment_datetime" TIMESTAMP(3),
    "actual_arrival" TIMESTAMP(3),
    "actual_departure" TIMESTAMP(3),
    "status" "StopStatus" NOT NULL DEFAULT 'PENDING',
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "notes" TEXT,

    CONSTRAINT "stop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_resulting_load_id_key" ON "quote"("resulting_load_id");

-- CreateIndex
CREATE INDEX "quote_organization_id_status_idx" ON "quote"("organization_id", "status");

-- CreateIndex
CREATE INDEX "quote_organization_id_customer_id_idx" ON "quote"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_organization_id_quote_number_key" ON "quote"("organization_id", "quote_number");

-- CreateIndex
CREATE INDEX "quote_stop_organization_id_quote_id_idx" ON "quote_stop"("organization_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "load_quote_id_key" ON "load"("quote_id");

-- CreateIndex
CREATE INDEX "load_organization_id_status_idx" ON "load"("organization_id", "status");

-- CreateIndex
CREATE INDEX "load_organization_id_customer_id_idx" ON "load"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "load_organization_id_assigned_dispatcher_id_idx" ON "load"("organization_id", "assigned_dispatcher_id");

-- CreateIndex
CREATE UNIQUE INDEX "load_organization_id_load_number_key" ON "load"("organization_id", "load_number");

-- CreateIndex
CREATE INDEX "stop_load_id_sequence_idx" ON "stop"("load_id", "sequence");

-- CreateIndex
CREATE INDEX "stop_organization_id_load_id_idx" ON "stop"("organization_id", "load_id");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_rate_agreement_id_fkey" FOREIGN KEY ("rate_agreement_id") REFERENCES "customer_rate_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_resulting_load_id_fkey" FOREIGN KEY ("resulting_load_id") REFERENCES "load"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_stop" ADD CONSTRAINT "quote_stop_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_rate_agreement_id_fkey" FOREIGN KEY ("rate_agreement_id") REFERENCES "customer_rate_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_assigned_carrier_id_fkey" FOREIGN KEY ("assigned_carrier_id") REFERENCES "carrier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_assigned_dispatcher_id_fkey" FOREIGN KEY ("assigned_dispatcher_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop" ADD CONSTRAINT "stop_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop" ADD CONSTRAINT "stop_customer_location_id_fkey" FOREIGN KEY ("customer_location_id") REFERENCES "customer_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

