import { Module } from '@nestjs/common';
import { LoadDraftController } from './controllers/load-draft.controller';
import { LoadDraftService } from './services/load-draft.service';

/**
 * Rate Confirmation → New Load auto-populate feature — Load Draft.
 * Deliberately imports nothing from RateConfirmationExtractionModule:
 * LoadDraftService resolves its source Document directly via
 * (organizationId, entityType, entityId) — the same lookup shape used
 * throughout this codebase — rather than depending on that module's
 * Redis job store, keeping this module fully decoupled from the
 * extraction pipeline (and, per the NON-NEGOTIABLE credit-saving
 * requirement, never touching it at all after creation time).
 */
@Module({
  controllers: [LoadDraftController],
  providers: [LoadDraftService],
})
export class LoadDraftModule {}
