import { HAS_EXPLICIT_DATABASE_URL, restoreExplicitEnv } from './e2e-env';
import '../../src/load-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import cookieParser = require('cookie-parser');
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { requestContextMiddleware } from '../../src/common/context/request-context.middleware';
import { TenantContext } from '../../src/common/tenant/tenant-context';

export const E2E_DB_ENABLED = HAS_EXPLICIT_DATABASE_URL;

let _sharedApp: INestApplication | null = null;

export async function getSharedE2eApp(): Promise<INestApplication> {
  if (!_sharedApp) {
    _sharedApp = await createE2eApp();
  }
  return _sharedApp;
}

/**
 * Builds the app and starts its HTTP server outside any TenantContext, the way
 * production starts. Test code runs with explicit system access (see
 * system-access.ts), but the app must not inherit it: requests, timers and
 * workers start with no context, so TENANT_CONTEXT_MODE=strict tests the app's
 * own entry points.
 */
export function createE2eApp(): Promise<INestApplication> {
  return TenantContext.exit(() => buildE2eApp());
}

/** Listens on an ephemeral port so supertest reuses this server instead of listening inside a test. */
export async function listenOutsideTenantContext(app: INestApplication): Promise<void> {
  const server = app.getHttpServer() as import('http').Server;
  if (server.listening) return;
  await TenantContext.exit(
    () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    }),
  );
}

async function buildE2eApp(): Promise<INestApplication> {
  restoreExplicitEnv();
  // The suites share one client IP and log in far more often than the per-IP
  // brute-force limits allow, so rate limiting is disabled for e2e apps.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getOptionsToken())
    .useValue({ throttlers: [{ name: 'global', ttl: 60_000, limit: 1 }], skipIf: () => true })
    .compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser(process.env.COOKIE_SECRET ?? 'test-secret-key-for-e2e-only'));
  app.use(requestContextMiddleware());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  await app.init();
  await listenOutsideTenantContext(app);
  return app;
}
