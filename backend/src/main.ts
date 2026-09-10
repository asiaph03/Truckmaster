import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Monitoring Phase 4A-8 — lets NestJS run every module's onModuleDestroy()
  // (closing BullMQ workers/queues, quitting duplicated Redis connections)
  // on SIGTERM/SIGINT, instead of every restart being an abrupt kill.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<AppConfig>);
  const port = config.get('port', { infer: true }) as number;
  const host = config.get('host', { infer: true }) as string;
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`TMS backend listening on ${host}:${port}`);
}

/**
 * Monitoring Phase 4A-8 — logs only that a shutdown signal arrived, before
 * Nest's own enableShutdownHooks()-driven teardown runs. Deliberately never
 * calls process.exit() — that would race Nest's own shutdown sequence.
 */
const shutdownLogger = new Logger('Bootstrap');
function logShutdownSignal(signal: string) {
  shutdownLogger.log(`graceful shutdown initiated (${signal})`);
}
process.on('SIGTERM', () => logShutdownSignal('SIGTERM'));
process.on('SIGINT', () => logShutdownSignal('SIGINT'));

bootstrap();
