import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SCOPES_KEY, type ApiScope } from '../scopes';
import type { ApiAuth } from '../api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/** Valida que a API key autenticada possui TODOS os escopos exigidos pela rota. */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApiScope[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const auth = req.apiAuth;
    if (!auth) throw new ForbiddenException('Sem contexto de autenticação.');

    const missing = required.filter((s) => !auth.scopes.includes(s));
    if (missing.length > 0) {
      throw new ForbiddenException(`Escopo insuficiente. Requer: ${missing.join(', ')}`);
    }
    return true;
  }
}
