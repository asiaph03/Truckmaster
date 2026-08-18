import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request, { Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

/**
 * Phase 0 end-to-end check: the full Nest application boots with every
 * Phase 0 module wired (Prisma, Redis, Storage, request-context
 * middleware, global exception filter) and /health reports connectivity.
 *
 * Requires a live PostgreSQL + Redis — natively (README.md "Local
 * Development": local PostgreSQL, Memurai for Redis) or via
 * `docker compose up -d` at the repo root, either works identically since
 * both target the same `.env` values. NOT run by CI yet
 * (docs/TECHNICAL_ARCHITECTURE.md notes service-container wiring starts
 * Phase 1). Run locally with:
 *   npm run test:e2e
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET) reports ok when Postgres and Redis are reachable', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res: Response) => {
        expect(res.body).toHaveProperty('status');
        expect(res.body.checks).toHaveProperty('database');
        expect(res.body.checks).toHaveProperty('redis');
      });
  });

  it('sets an x-request-id header on every response (correlation ID, §9.3)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect((res) => {
        expect(res.headers['x-request-id']).toBeDefined();
      });
  });
});
