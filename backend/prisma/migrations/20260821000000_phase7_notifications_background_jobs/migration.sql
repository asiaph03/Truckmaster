-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('COMPLIANCE_EXPIRING_30_DAY', 'COMPLIANCE_EXPIRING_15_DAY', 'COMPLIANCE_EXPIRING_7_DAY', 'CHECK_CALL_OVERDUE');

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" UUID,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_organization_id_recipient_user_id_read_idx" ON "notification"("organization_id", "recipient_user_id", "read");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

