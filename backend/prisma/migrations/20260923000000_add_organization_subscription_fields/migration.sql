-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "max_carriers" INTEGER,
ADD COLUMN     "max_drivers" INTEGER,
ADD COLUMN     "subscription_converted_at" TIMESTAMP(3),
ADD COLUMN     "subscription_converted_by_user_id" UUID,
ADD COLUMN     "subscription_status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "trial_ends_at" TIMESTAMP(3),
ADD COLUMN     "trial_started_at" TIMESTAMP(3);
