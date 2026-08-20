-- CreateIndex
CREATE INDEX "carrier_payment_organization_id_status_submitted_at_idx" ON "carrier_payment"("organization_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "invoice_organization_id_status_due_date_idx" ON "invoice"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "load_organization_id_invoiced_idx" ON "load"("organization_id", "invoiced");

