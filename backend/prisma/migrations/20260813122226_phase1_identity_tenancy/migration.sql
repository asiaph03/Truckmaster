-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('DUE_ON_RECEIPT', 'NET_15', 'NET_30', 'NET_45', 'NET_60');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING_VERIFICATION', 'INVITED', 'ACTIVE', 'INACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MembershipRoleName" AS ENUM ('ADMIN', 'OPERATIONS_MANAGER', 'DISPATCHER', 'SALES_BOOKING', 'ACCOUNTING', 'COMPLIANCE_REVIEWER');

-- CreateEnum
CREATE TYPE "OrganizationSequenceType" AS ENUM ('LOAD', 'QUOTE', 'INVOICE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('HUMAN', 'SYSTEM', 'AI');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT NOT NULL,
    "is_platform_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "primary_contact_name" TEXT NOT NULL,
    "primary_contact_email" TEXT NOT NULL,
    "primary_contact_phone" TEXT NOT NULL,
    "default_payment_terms" "PaymentTerms" NOT NULL DEFAULT 'NET_30',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_membership" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "invited_by_user_id" UUID,
    "invited_at" TIMESTAMP(3),
    "invitation_token_hash" TEXT,
    "invitation_expires_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "deactivated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_role" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role" "MembershipRoleName" NOT NULL,

    CONSTRAINT "membership_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_sequence" (
    "organization_id" UUID NOT NULL,
    "sequence_type" "OrganizationSequenceType" NOT NULL,
    "current_value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "organization_sequence_pkey" PRIMARY KEY ("organization_id","sequence_type")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL DEFAULT 'HUMAN',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "previous_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL DEFAULT 'HUMAN',
    "correlation_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "organization_membership_organization_id_idx" ON "organization_membership"("organization_id");

-- CreateIndex
CREATE INDEX "organization_membership_user_id_idx" ON "organization_membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_membership_organization_id_user_id_key" ON "organization_membership"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "membership_role_organization_id_idx" ON "membership_role"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_role_membership_id_role_key" ON "membership_role"("membership_id", "role");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_entity_type_entity_id_created_at_idx" ON "audit_log"("organization_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_actor_user_id_created_at_idx" ON "audit_log"("organization_id", "actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "domain_event_organization_id_event_type_occurred_at_idx" ON "domain_event"("organization_id", "event_type", "occurred_at");

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_deactivated_by_user_id_fkey" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_sequence" ADD CONSTRAINT "organization_sequence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

