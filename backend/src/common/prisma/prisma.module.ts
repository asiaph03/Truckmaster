import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so every feature module (Phase 1+) can inject PrismaService
 * without re-importing this module everywhere — matches the "one shared
 * data access layer per app, not per module" structure in
 * TECHNICAL_ARCHITECTURE.md §1.2.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
