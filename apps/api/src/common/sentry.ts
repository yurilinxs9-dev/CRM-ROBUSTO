import * as Sentry from '@sentry/node';

let initialized = false;

/**
 * Initialize Sentry once at bootstrap. No-ops if SENTRY_DSN is absent, which
 * lets dev/CI environments skip observability cost without special casing.
 */
export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env['SENTRY_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
    release: process.env['SENTRY_RELEASE'],
    tracesSampleRate: parseFloat(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.0'),
    profilesSampleRate: parseFloat(process.env['SENTRY_PROFILES_SAMPLE_RATE'] ?? '0.0'),
    // Scrub PII at SDK boundary (complements Pino redact paths for logs).
    sendDefaultPii: false,
  });
  initialized = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
