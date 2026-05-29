import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ApiAuth } from '../api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/**
 * Rate-limit por API key (fixed window). In-memory — adequado ao deploy atual
 * (backend single-container). Se escalar pra múltiplas réplicas, trocar por
 * contador no Redis (RedisCacheService) para limite global consistente.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windowMs = 60_000;
  private readonly max = 120; // req/min por chave
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const key = req.apiAuth?.keyId ?? req.ip ?? 'anon';
    const now = Date.now();

    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }

    cur.count += 1;
    if (cur.count > this.max) {
      const retryAfter = Math.ceil((cur.resetAt - now) / 1000);
      throw new HttpException(
        { error: 'Too Many Requests', message: `Limite de requisições excedido. Tente em ${retryAfter}s.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Remove janelas expiradas ocasionalmente para o Map não crescer sem limite. */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) {
      if (v.resetAt <= now) this.hits.delete(k);
    }
  }
}
