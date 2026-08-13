-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PaymentTermsSource" AS ENUM ('INHERITED', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "CustomerContactRole" AS ENUM ('BOOKING', 'OPERATIONS', 'BILLING', 'MANAGEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomerLocationType" AS ENUM ('PICKUP', 'DELIVERY', 'OTHER');

-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('DRY_VAN', 'REEFER', 'FLATBED');

-- CreateEnum
CREATE TYPE "CarrierStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CarrierContactRole" AS ENUM ('DISPATCH', 'SAFETY_COMPLIANCE', 'BILLING', 'FACTORING', 'MANAGEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "InsuranceCoverageType" AS ENUM ('AUTO_LIABILITY', 'CARGO');

-- CreateEnum
CREATE TYPE "CarrierServiceAreaType" AS ENUM ('LANE', 'REGION');

-- CreateEnum
CREATE TYPE "DocumentEntityType" AS ENUM ('LOAD', 'STOP', 'CUSTOMER', 'CARRIER', 'DRIVER', 'TRUCK', 'TRAILER', 'INVOICE', 'CARRIER_PAYMENT');

-- CreateEnum
CREATE TYPE "DocumentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SCAN_FAILED');

-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DocumentTypeCategory" AS ENUM ('LOAD', 'CARRIER_COMPLIANCE');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "billing_address_line1" TEXT NOT NULL,
    "billing_city" TEXT NOT NULL,
    "billing_state" TEXT NOT NULL,
    "billing_zip" TEXT NOT NULL,
    "billing_country" TEXT NOT NULL DEFAULT 'US',
    "primary_contact_name" TEXT NOT NULL,
    "primary_contact_email" TEXT NOT NULL,
    "primary_contact_phone" TEXT NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'PROSPECT',
    "account_owner_user_id" UUID,
    "payment_terms" "PaymentTerms" NOT NULL,
    "payment_terms_source" "PaymentTermsSource" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "CustomerContactRole" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_location" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "location_type" "CustomerLocationType" NOT NULL,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "operating_hours" TEXT,
    "appointment_requirements" TEXT,
    "notes" TEXT,

    CONSTRAINT "customer_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_rate_agreement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "origin_city" TEXT NOT NULL,
    "origin_state" TEXT NOT NULL,
    "destination_city" TEXT NOT NULL,
    "destination_state" TEXT NOT NULL,
    "equipment_type" "EquipmentType" NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "rate_type" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "fuel_surcharge_rules" TEXT,
    "notes" TEXT,

    CONSTRAINT "customer_rate_agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "dba" TEXT,
    "mc_number" TEXT NOT NULL,
    "dot_number" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "primary_contact_name" TEXT NOT NULL,
    "primary_contact_phone" TEXT NOT NULL,
    "primary_contact_email" TEXT NOT NULL,
    "status" "CarrierStatus" NOT NULL DEFAULT 'PENDING',
    "assignment_eligible" BOOLEAN NOT NULL DEFAULT false,
    "ineligibility_reasons" JSONB,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_contact" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "CarrierContactRole" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "carrier_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_insurance" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "coverage_type" "InsuranceCoverageType" NOT NULL,
    "coverage_amount" DECIMAL(12,2) NOT NULL,
    "insurance_company" TEXT NOT NULL,
    "agent_contact" TEXT,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE NOT NULL,
    "coi_document_id" UUID NOT NULL,

    CONSTRAINT "carrier_insurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_fmcsa_verification" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "verification_date" DATE NOT NULL,
    "result_status" TEXT NOT NULL,
    "verified_by_user_id" UUID NOT NULL,
    "authority_info" TEXT,
    "notes" TEXT,

    CONSTRAINT "carrier_fmcsa_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_service_area" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "type" "CarrierServiceAreaType" NOT NULL,
    "origin_city" TEXT,
    "origin_state" TEXT,
    "destination_city" TEXT,
    "destination_state" TEXT,
    "region_label" TEXT,
    "notes" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_service_area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_factoring_info" (
    "carrier_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "uses_factoring" BOOLEAN NOT NULL DEFAULT false,
    "factoring_company" TEXT,
    "remit_to_address" TEXT,
    "factoring_contact" TEXT,
    "payment_instructions" TEXT,
    "noa_status" TEXT,
    "noa_document_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_factoring_info_pkey" PRIMARY KEY ("carrier_id")
);

-- CreateTable
CREATE TABLE "driver" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "license_number" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "unit_number" TEXT NOT NULL,
    "truck_type" "EquipmentType" NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "vin" TEXT,
    "plate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trailer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "unit_number" TEXT NOT NULL,
    "trailer_type" "EquipmentType" NOT NULL,
    "vin" TEXT,
    "plate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "trailer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type_definition" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "category" "DocumentTypeCategory" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "is_system_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "document_type_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_family_id" UUID NOT NULL,
    "entity_type" "DocumentEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "custom_type_label" TEXT,
    "file_storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "is_current_version" BOOLEAN NOT NULL DEFAULT true,
    "scan_status" "DocumentScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanned_at" TIMESTAMP(3),
    "scan_provider" TEXT,
    "review_status" "DocumentReviewStatus",
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "expiration_date" DATE,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_organization_id_status_idx" ON "customer"("organization_id", "status");

-- CreateIndex
CREATE INDEX "customer_organization_id_legal_name_idx" ON "customer"("organization_id", "legal_name");

-- CreateIndex
CREATE INDEX "customer_contact_organization_id_customer_id_idx" ON "customer_contact"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "customer_location_organization_id_customer_id_idx" ON "customer_location"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "customer_rate_agreement_organization_id_customer_id_idx" ON "customer_rate_agreement"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "carrier_organization_id_assignment_eligible_idx" ON "carrier"("organization_id", "assignment_eligible");

-- CreateIndex
CREATE INDEX "carrier_organization_id_status_idx" ON "carrier"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_organization_id_mc_number_key" ON "carrier"("organization_id", "mc_number");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_organization_id_dot_number_key" ON "carrier"("organization_id", "dot_number");

-- CreateIndex
CREATE INDEX "carrier_contact_organization_id_carrier_id_idx" ON "carrier_contact"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "carrier_insurance_organization_id_carrier_id_idx" ON "carrier_insurance"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "carrier_fmcsa_verification_organization_id_carrier_id_idx" ON "carrier_fmcsa_verification"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "carrier_service_area_organization_id_carrier_id_idx" ON "carrier_service_area"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "driver_organization_id_carrier_id_idx" ON "driver"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "truck_organization_id_carrier_id_idx" ON "truck"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "trailer_organization_id_carrier_id_idx" ON "trailer"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "document_type_definition_organization_id_category_idx" ON "document_type_definition"("organization_id", "category");

-- CreateIndex
CREATE INDEX "document_organization_id_entity_type_entity_id_is_current_v_idx" ON "document"("organization_id", "entity_type", "entity_id", "is_current_version");

-- CreateIndex
CREATE INDEX "document_organization_id_scan_status_idx" ON "document"("organization_id", "scan_status");

-- CreateIndex
CREATE INDEX "document_organization_id_document_family_id_idx" ON "document"("organization_id", "document_family_id");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_account_owner_user_id_fkey" FOREIGN KEY ("account_owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location" ADD CONSTRAINT "customer_location_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_rate_agreement" ADD CONSTRAINT "customer_rate_agreement_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_contact" ADD CONSTRAINT "carrier_contact_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_insurance" ADD CONSTRAINT "carrier_insurance_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_insurance" ADD CONSTRAINT "carrier_insurance_coi_document_id_fkey" FOREIGN KEY ("coi_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_fmcsa_verification" ADD CONSTRAINT "carrier_fmcsa_verification_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_fmcsa_verification" ADD CONSTRAINT "carrier_fmcsa_verification_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_service_area" ADD CONSTRAINT "carrier_service_area_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_service_area" ADD CONSTRAINT "carrier_service_area_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_factoring_info" ADD CONSTRAINT "carrier_factoring_info_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_factoring_info" ADD CONSTRAINT "carrier_factoring_info_noa_document_id_fkey" FOREIGN KEY ("noa_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck" ADD CONSTRAINT "truck_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trailer" ADD CONSTRAINT "trailer_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_definition" ADD CONSTRAINT "document_type_definition_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

