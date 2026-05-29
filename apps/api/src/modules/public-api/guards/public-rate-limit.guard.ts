import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import type { ApiAuth } from '../api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/**
 * Rate-limit por API key usando Redis (fixed window) — limite global e
 * consistente entre múltiplas réplicas do backend. Fail-open: se o Redis
 * estiver indisponível (incr → 0), a requisição passa.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windowSeconds = 60;
  private readonly max = 120; // req/min por chave

  constructor(private readonly cache: RedisCacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const id = req.apiAuth?.keyId ?? req.ip ?? 'anon';
    const window = Math.floor(Date.now() / 1000 / this.windowSeconds);
    const key = `ratelimit:apikey:${id}:${window}`;

    const count = await this.cache.incr(key, this.windowSeconds);
    if (count > this.max) {
      throw new HttpException(
        { error: 'Too Many Requests', message: `Limite de ${this.max} req/min excedido.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
