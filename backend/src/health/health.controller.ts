import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { Public } from '../common/decorators/public.decorator';

interface HealthCheckResult {
  status: 'ok' | 'degraded';
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}

/**
 * TECHNICAL_ARCHITECTURE.md §12.2 — health endpoint verifying DB and Redis
 * connectivity, the two dependencies most likely to silently break a
 * deployment (and, per §12.2's specific warning, several locked business
 * behaviors — compliance expiration sweeps, quote expiration — depend on
 * the scheduler/DB actually being reachable).
 *
 * Excluded from the global `/api/v1` prefix (see main.ts) since health
 * checks are an infra concern, not a versioned business API.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async check(): Promise<HealthCheckResult> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const status = database === 'ok' && redis === 'ok' ? 'ok' : 'degraded';
    return { status, checks: { database, redis } };
  }

  private async checkDatabase(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }
}
