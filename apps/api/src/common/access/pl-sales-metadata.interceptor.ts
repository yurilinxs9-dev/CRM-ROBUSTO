import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { isPlSalesOnly } from './pl-sales-access';
import { accessPath, AccessRequest } from './pl-sales-policy.service';

function withoutCounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCounts);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_count' && key !== 'total').map(([key, child]) => [key, withoutCounts(child)]));
}

@Injectable()
export class PlSalesMetadataInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AccessRequest>();
    if (!request.user || !isPlSalesOnly(request.user) || !['GET', 'HEAD'].includes(request.method.toUpperCase())) return next.handle();
    const path = accessPath(request);
    if (!['/pipelines', '/tags', '/sectors'].includes(path) && !path.startsWith('/pipelines/')) return next.handle();
    // The legacy metadata services include tenant-wide aggregates. Never expose
    // them to this profile or mutate a cached/shared response object in place.
    return next.handle().pipe(map(withoutCounts));
  }
}
