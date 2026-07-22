import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ScopesGuard } from './common/auth/scopes.guard';

async function bootstrap(): Promise<void> {
  // rawBody enables webhook handlers to verify provider signatures over the
  // exact bytes received (Stripe / Square HMAC) — see the ops webhook modules.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('v1', {
    exclude: ['health', 'dashboard', 'outcomes', 'deliverables', 'deliverables/(.*)'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalGuards(new ScopesGuard(app.get(Reflector)));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Atlas — Primitive API')
    .setDescription(
      'The public tenant contract: primitives across Guest / Ops / Marketing hubs. See docs/architecture/primitive-api-spec.md',
    )
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'X-Tenant-Id', in: 'header' }, 'tenant')
    .build();
  const doc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, doc);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

void bootstrap();
