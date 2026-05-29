import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import type { ApiAuth } from './api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

const TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Idempotência para POST/PATCH: se o cliente enviar header `Idempotency-Key`,
 * a primeira resposta é cacheada (Redis) e replays com a mesma chave retornam
 * o resultado cacheado — evita ações duplicadas (ex.: mensagem enviada 2x em retry).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly cache: RedisCacheService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (req.method !== 'POST' && req.method !== 'PATCH') return next.handle();

    const idem = req.headers['idempotency-key'];
    if (!idem || typeof idem !== 'string') return next.handle();

    const tenant = req.apiAuth?.tenantId ?? 'anon';
    const cacheKey = `idemp:${tenant}:${req.method}:${req.path}:${idem}`;

    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached !== null) {
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Idempotent-Replayed', 'true');
      return of(cached);
    }

    return next.handle().pipe(
      tap((body) => {
        void this.cache.set(cacheKey, body, TTL_SECONDS);
      }),
    );
  }
}
