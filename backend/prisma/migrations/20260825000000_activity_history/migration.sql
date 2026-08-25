-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "communication_activity" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "logged_by_user_id" UUID NOT NULL,
    "activity_type" TEXT NOT NULL,
    "direction" "CommunicationDirection",
    "contact_person" TEXT,
    "notes" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_note" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "communication_activity_organization_id_load_id_idx" ON "communication_activity"("organization_id", "load_id");

-- CreateIndex
CREATE INDEX "internal_note_organization_id_load_id_idx" ON "internal_note"("organization_id", "load_id");

-- AddForeignKey
ALTER TABLE "communication_activity" ADD CONSTRAINT "communication_activity_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_activity" ADD CONSTRAINT "communication_activity_logged_by_user_id_fkey" FOREIGN KEY ("logged_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_note" ADD CONSTRAINT "internal_note_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "load"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_note" ADD CONSTRAINT "internal_note_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
