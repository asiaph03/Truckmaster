import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { PrismaService } from '../common/prisma/prisma.service';

function buildResMock() {
  return { status: jest.fn() } as unknown as Response;
}

function buildController(databaseOk: boolean, redisOk: boolean) {
  const prisma = {
    $queryRaw: databaseOk
      ? jest.fn().mockResolvedValue([{ '?column?': 1 }])
      : jest.fn().mockRejectedValue(new Error('connection refused')),
  } as unknown as PrismaService;

  const redis = {
    ping: redisOk
      ? jest.fn().mockResolvedValue('PONG')
      : jest.fn().mockRejectedValue(new Error('connection refused')),
  };

  return new HealthController(prisma, redis as never);
}

describe('HealthController', () => {
  it('A. database ok + redis ok -> 200 with status "ok"', async () => {
    const controller = buildController(true, true);
    const res = buildResMock();

    const body = await controller.check(res);

    expect(res.status).not.toHaveBeenCalled();
    expect(body).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
  });

  it('B. database error + redis ok -> 503 with status "degraded"', async () => {
    const controller = buildController(false, true);
    const res = buildResMock();

    const body = await controller.check(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toEqual({ status: 'degraded', checks: { database: 'error', redis: 'ok' } });
  });

  it('C. database ok + redis error -> 503 with status "degraded"', async () => {
    const controller = buildController(true, false);
    const res = buildResMock();

    const body = await controller.check(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toEqual({ status: 'degraded', checks: { database: 'ok', redis: 'error' } });
  });

  it('D. database error + redis error -> 503 with status "degraded"', async () => {
    const controller = buildController(false, false);
    const res = buildResMock();

    const body = await controller.check(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toEqual({ status: 'degraded', checks: { database: 'error', redis: 'error' } });
  });
});
