import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService } from '../api-key.service';
import type { ApiAuth } from '../api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/**
 * Autentica requisições da API pública via `Authorization: Bearer <token>`.
 * Resolve o tenant + escopos a partir do hash da chave e anexa em req.apiAuth.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const header = req.headers['authorization'];

    if (!header || !/^bearer\s+/i.test(header)) {
      throw new UnauthorizedException('Token de API ausente ou não fornecido.');
    }

    const token = header.replace(/^bearer\s+/i, '').trim();
    const auth = await this.keys.verify(token);
    if (!auth) {
      throw new UnauthorizedException('Token de API inválido ou não fornecido.');
    }

    req.apiAuth = auth;
    return true;
  }
}
