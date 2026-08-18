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
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`TMS backend listening on port ${port}`);
}

bootstrap();
