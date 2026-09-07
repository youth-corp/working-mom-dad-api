import 'dotenv/config'; // PrismaService가 DATABASE_URL을 읽기 전에 .env 로드 (NestJS 기본은 .env 미로드)

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { performanceMiddleware } from './common/performance';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(performanceMiddleware());

  app.enableCors({
    origin: [process.env.WEB_ORIGIN, process.env.ADMIN_ORIGIN].filter(
      (origin): origin is string => Boolean(origin),
    ),
    credentials: true,
    exposedHeaders: ['X-Request-ID', 'Server-Timing', 'X-API-Release'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Yougabell API')
    .setDescription('육아벨 domain API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  app.getHttpAdapter().get('/openapi.json', (_: Request, res: Response) => {
    res.json(document);
  });

  if (process.env.OPENAPI_EXPORT_PATH) {
    writeFileSync(
      process.env.OPENAPI_EXPORT_PATH,
      JSON.stringify(document, null, 2),
    );
  }

  // 포트 할당: web=3000, api=3001, admin=3002 (운영 환경에서는 PORT env로 override)
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
