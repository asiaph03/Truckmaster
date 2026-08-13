import 'reflect-metadata';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { REDIS_CLIENT } from './common/redis/redis.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<AppConfig>);

  // Security headers (§11 TECHNICAL_ARCHITECTURE.md)
  app.use(helmet());
  app.use(cookieParser());

  // Redis-backed sessions (§3.2/§11) — chosen specifically so
  // deactivating a membership can revoke access immediately (Decision 3;
  // Workflow 1 §1.7 "Deactivated user's active sessions are terminated
  // immediately") by deleting the session key server-side, which a
  // stateless JWT cannot do without an additional revocation-list layer.
  const redisClient = app.get<Redis>(REDIS_CLIENT);
  const isProduction = config.get('nodeEnv', { infer: true }) === 'production';
  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: 'tms:sess:' }),
      secret: config.get('session.secret', { infer: true }) as string,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    }),
  );

  // Shape validation at the API boundary (§2.4) — reject malformed requests
  // before they ever reach business logic. Business-rule validation happens
  // in the service layer, not here.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  const port = config.get('port', { infer: true }) as number;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`TMS backend listening on port ${port}`);
}

bootstrap();
