-- AlterEnum
ALTER TYPE "LoadStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "load" ADD COLUMN "cancelled_at" TIMESTAMP(3),
ADD COLUMN "cancelled_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "load" ADD CONSTRAINT "load_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
