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

/**
 * Monitoring Phase 4A-9 — a genuinely unhandled promise rejection or
 * synchronous throw outside any try/catch means the process may be in a
 * corrupted state (Node's own guidance for uncaughtException). This
 * deliberately does NOT attempt app.close()/graceful Nest shutdown — that
 * runs a long async chain (8 workers' worker.close(), 7 queues' close(),
 * Redis .quit(), Prisma $disconnect()) with no built-in timeout, which
 * risks hanging forever in exactly the state this handler exists to fail
 * fast out of. process.exit(1) is immediate and lets NSSM's own, already-
 * proven crash-restart (AppRestartDelay) recover the service from a clean
 * OS-level process boundary instead.
 *
 * On Node 15+ (this deploys on v24), an unhandled rejection with no
 * listener is already fatal by default — registering a listener here
 * preserves that safety property (still exits) while adding structured,
 * attributable logging in place of Node's raw stderr dump.
 *
 * Deliberately has no access to RequestContextStore/organizationId/userId
 * — a process-level event isn't reliably attributable to any one request
 * or job, and guessing would risk misattributing the crash.
 */
const fatalLogger = new Logger('FatalError');

function describeFatalError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  try {
    return { message: String(error) };
  } catch {
    return { message: 'Unknown non-Error value' };
  }
}

function handleFatalError(eventType: 'unhandledRejection' | 'uncaughtException', error: unknown): void {
  const { message, stack } = describeFatalError(error);
  fatalLogger.error(
    `${eventType}: ${message} (pid=${process.pid}, uptime=${process.uptime().toFixed(1)}s)`,
    stack,
  );
  process.exit(1);
}

process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (error) => handleFatalError('uncaughtException', error));

bootstrap();
