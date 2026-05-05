import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { RedisIoAdapter } from './common/socket/redis-io.adapter';
import { json, raw, urlencoded } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { initSentry } from './common/sentry';

async function bootstrap() {
  // Initialize Sentry BEFORE the Nest app so SDK instrumentation patches
  // http/express handlers at module-load time. Silently no-ops without SENTRY_DSN.
  initSentry();

  const app = await NestFactory.create(AppModule);

  // Replace Nest default logger with Pino (must run before anything logs).
  app.useLogger(app.get(PinoLogger));

  // Security headers. API-only (no HTML) → we disable CSP & cross-origin-resource-policy
  // since they only matter for browser-rendered responses.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  // Body limits: tight default to limit DoS surface; the upload-heavy paths
  // (media uploads, base64 audio in chat, raw octet-stream binaries) keep the
  // larger 60mb ceiling for ~40MB binaries that balloon to ~53MB once base64-encoded.
  const LARGE_BODY_PATHS = ['/api/media', '/api/messages'];
  for (const path of LARGE_BODY_PATHS) {
    app.use(path, json({ limit: '60mb' }));
    app.use(path, urlencoded({ extended: true, limit: '60mb' }));
  }
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.use(raw({ limit: '60mb', type: 'application/octet-stream' }));

  // Parse Cookie header so AuthController.refresh can read req.cookies.refresh_token.
  // Without this every /api/auth/refresh would 500 even with a valid cookie present.
  app.use(cookieParser());

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Accept a comma-separated list of origins in FRONTEND_URL so we can run
  // Vercel preview + prod + localhost without rebuilding.
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`CRM API running on port ${port}`);
}
bootstrap();
