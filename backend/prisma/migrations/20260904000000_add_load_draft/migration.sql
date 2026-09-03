-- CreateTable
CREATE TABLE "load_draft" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "rate_confirmation_document_id" UUID NOT NULL,
    "extracted_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "load_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "load_draft_rate_confirmation_document_id_key" ON "load_draft"("rate_confirmation_document_id");

-- CreateIndex
CREATE INDEX "load_draft_organization_id_idx" ON "load_draft"("organization_id");

-- AddForeignKey
ALTER TABLE "load_draft" ADD CONSTRAINT "load_draft_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_draft" ADD CONSTRAINT "load_draft_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_draft" ADD CONSTRAINT "load_draft_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_draft" ADD CONSTRAINT "load_draft_rate_confirmation_document_id_fkey" FOREIGN KEY ("rate_confirmation_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
