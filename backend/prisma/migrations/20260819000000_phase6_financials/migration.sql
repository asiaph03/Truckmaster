-- CreateEnum
CREATE TYPE "ChargeLineItemSide" AS ENUM ('CUSTOMER', 'CARRIER');

-- CreateEnum
CREATE TYPE "ChargeLineItemSource" AS ENUM ('ORIGINAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'VOID', 'CREDITED');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "CarrierPaymentType" AS ENUM ('DEPOSIT', 'PARTIAL', 'BALANCE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CarrierPaymentStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID');

-- CreateTable
CREATE TABLE "charge_type_definition" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_system_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "charge_type_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_line_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "side" "ChargeLineItemSide" NOT NULL,
    "charge_type_id" UUID NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit_rate" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" "ChargeLineItemSource" NOT NULL,
    "notes" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "sent_at" TIMESTAMP(3),
    "due_date" DATE,
    "total" DECIMAL(12,2) NOT NULL,
    "remaining_balance" DECIMAL(12,2) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_load" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "load_total_at_invoice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source_load_id" UUID,
    "source_charge_line_item_id" UUID,

    CONSTRAINT "invoice_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_date" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference_number" TEXT,
    "notes" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "adjustment_date" DATE NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_payment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_type" "CarrierPaymentType" NOT NULL,
    "method" TEXT,
    "reference_number" TEXT,
    "notes" TEXT,
    "status" "CarrierPaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "prepared_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "last_rejected_by_user_id" UUID,
    "last_rejected_at" TIMESTAMP(3),
    "last_rejection_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "charge_type_definition_organization_id_idx" ON "charge_type_definition"("organization_id");

-- CreateIndex
CREATE INDEX "charge_line_item_organization_id_load_id_idx" ON "charge_line_item"("organization_id", "load_id");

-- CreateIndex
CREATE INDEX "invoice_organization_id_status_idx" ON "invoice"("organization_id", "status");

-- CreateIndex
CREATE INDEX "invoice_organization_id_customer_id_idx" ON "invoice"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_organization_id_invoice_number_key" ON "invoice"("organization_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_load_organization_id_invoice_id_idx" ON "invoice_load"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_load_organization_id_load_id_idx" ON "invoice_load"("organization_id", "load_id");

-- CreateIndex
CREATE INDEX "invoice_line_item_organization_id_invoice_id_idx" ON "invoice_line_item"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_organization_id_invoice_id_idx" ON "payment"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "adjustment_organization_id_invoice_id_idx" ON "adjustment"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "carrier_payment_organization_id_load_id_idx" ON "carrier_payment"("organization_id", "load_id");

-- CreateIndex
CREATE INDEX "carrier_payment_organization_id_carrier_id_idx" ON "carrier_payment"("organization_id", "carrier_id");

-- CreateIndex
CREATE INDEX "carrier_payment_organization_id_status_idx" ON "carrier_payment"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "charge_type_definition" ADD CONSTRAINT "charge_type_definition_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_line_item" ADD CONSTRAINT "charge_line_item_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_line_item" ADD CONSTRAINT "charge_line_item_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_type_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_line_item" ADD CONSTRAINT "charge_line_item_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_load" ADD CONSTRAINT "invoice_load_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_load" ADD CONSTRAINT "invoice_load_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_source_load_id_fkey" FOREIGN KEY ("source_load_id") REFERENCES "load"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_source_charge_line_item_id_fkey" FOREIGN KEY ("source_charge_line_item_id") REFERENCES "charge_line_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_payment" ADD CONSTRAINT "carrier_payment_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_payment" ADD CONSTRAINT "carrier_payment_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_payment" ADD CONSTRAINT "carrier_payment_prepared_by_user_id_fkey" FOREIGN KEY ("prepared_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_payment" ADD CONSTRAINT "carrier_payment_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_payment" ADD CONSTRAINT "carrier_payment_last_rejected_by_user_id_fkey" FOREIGN KEY ("last_rejected_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

