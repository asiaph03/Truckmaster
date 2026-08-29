-- CreateEnum
CREATE TYPE "ImportEntityType" AS ENUM ('CUSTOMER', 'CUSTOMER_CONTACT', 'CUSTOMER_LOCATION', 'CARRIER', 'CARRIER_CONTACT', 'DRIVER', 'TRUCK', 'TRAILER');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'MAPPING', 'VALIDATED', 'IMPORTING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'IMPORTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "ImportEntityType" NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_format" TEXT NOT NULL,
    "column_mapping" JSONB,
    "total_rows" INTEGER,
    "valid_row_count" INTEGER,
    "invalid_row_count" INTEGER,
    "imported_row_count" INTEGER,
    "failed_row_count" INTEGER,
    "skipped_row_count" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch_row" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "mapped_data" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'VALID',
    "errors" JSONB,
    "duplicate_warning" JSONB,
    "acknowledge_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "created_entity_id" UUID,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "import_batch_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batch_organization_id_entity_type_created_at_idx" ON "import_batch"("organization_id", "entity_type", "created_at");

-- CreateIndex
CREATE INDEX "import_batch_row_organization_id_import_batch_id_status_idx" ON "import_batch_row"("organization_id", "import_batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_batch_row_import_batch_id_row_number_key" ON "import_batch_row"("import_batch_id", "row_number");

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch_row" ADD CONSTRAINT "import_batch_row_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

