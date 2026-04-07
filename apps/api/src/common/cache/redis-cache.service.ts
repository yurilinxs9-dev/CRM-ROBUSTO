import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin Redis cache layer backed by ioredis.
 * All methods are best-effort: failures are logged but never thrown,
 * so the request path stays resilient when Redis is unavailable.
 */
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client: Redis | null;

  constructor(config: ConfigService) {
    const url =
      config.get<string>('REDIS_URL') ??
      config.get<string>('UPSTASH_REDIS_TLS_URL') ??
      config.get<string>('UPSTASH_REDIS_URL');

    if (!url) {
      this.logger.warn('REDIS_URL not set — RedisCacheService disabled');
      this.client = null;
      return;
    }

    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    });
    this.client.on('error', (err) => this.logger.warn(`cache error: ${String(err)}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* ignore */
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`get(${key}) failed: ${String(err)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`set(${key}) failed: ${String(err)}`);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`del(${key}) failed: ${String(err)}`);
    }
  }

  /**
   * Delete all keys matching a glob pattern (e.g. `leads:list:tenant-1:*`).
   * Uses SCAN + UNLINK to avoid blocking Redis.
   */
  async delPattern(pattern: string): Promise<void> {
    if (!this.client) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          await this.client.unlink(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`delPattern(${pattern}) failed: ${String(err)}`);
    }
  }
}
