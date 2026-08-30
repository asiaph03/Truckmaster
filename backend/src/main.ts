import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService<AppConfig>);
  const port = config.get('port', { infer: true }) as number;
  const host = config.get('host', { infer: true }) as string;
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`TMS backend listening on ${host}:${port}`);
}

bootstrap();
