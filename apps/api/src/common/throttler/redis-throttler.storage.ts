import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * ThrottlerStorage em Redis — contadores de rate limit compartilhados entre
 * réplicas (o storage default é in-memory e fragmenta o limite por processo).
 * Sem REDIS_URL ou com Redis fora, degrada pra contador em memória (fail-open
 * consciente: melhor rate limit local do que derrubar a API).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly client: Redis | null;
  private readonly memory = new Map<string, { hits: number; expiresAt: number }>();

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL not set — throttler usando contador em memória');
      this.client = null;
      return;
    }
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    });
    this.client.on('error', (err) => this.logger.warn(`throttler redis error: ${String(err)}`));
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

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    if (this.client) {
      try {
        const redisKey = `throttle:${key}`;
        const multi = this.client.multi();
        multi.incr(redisKey);
        multi.pttl(redisKey);
        const results = await multi.exec();
        const totalHits = Number(results?.[0]?.[1] ?? 1);
        let pttl = Number(results?.[1]?.[1] ?? -1);
        if (pttl < 0) {
          await this.client.pexpire(redisKey, ttl);
          pttl = ttl;
        }
        return { totalHits, timeToExpire: Math.ceil(pttl / 1000) };
      } catch {
        /* cai pro fallback em memória */
      }
    }
    return this.incrementInMemory(key, ttl);
  }

  private incrementInMemory(key: string, ttl: number): ThrottlerStorageRecord {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.memory.set(key, { hits: 1, expiresAt: now + ttl });
      return { totalHits: 1, timeToExpire: Math.ceil(ttl / 1000) };
    }
    entry.hits += 1;
    return {
      totalHits: entry.hits,
      timeToExpire: Math.ceil((entry.expiresAt - now) / 1000),
    };
  }
}
