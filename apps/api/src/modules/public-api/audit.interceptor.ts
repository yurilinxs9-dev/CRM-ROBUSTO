import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ApiAuth } from './api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/**
 * Registra cada requisição autenticada da API pública em ApiRequestLog
 * (fire-and-forget). Só loga quando há tenant resolvido (req.apiAuth).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    const record = (status: number) => {
      const auth = req.apiAuth;
      if (!auth?.tenantId) return; // 401 sem chave válida → não atribuível
      this.prisma.apiRequestLog
        .create({
          data: {
            tenant_id: auth.tenantId,
            api_key_id: auth.keyId ?? null,
            method: req.method,
            path: req.path,
            status_code: status,
            duration_ms: Date.now() - start,
            ip: req.ip ?? null,
          },
        })
        .catch((err) => this.logger.warn(`audit log falhou: ${String(err)}`));
    };

    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode || 200),
        error: (err: { status?: number }) => record(err?.status ?? 500),
      }),
    );
  }
}
