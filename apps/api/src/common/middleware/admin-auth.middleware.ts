import { Injectable, NestMiddleware, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * Protects /admin/* routes for SUPER_ADMIN only.
 * Accepts token from Authorization: Bearer <jwt> header OR ?token=<jwt> query (for browser convenience).
 */
@Injectable()
export class AdminAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    }
    if (!token && typeof req.query['token'] === 'string') {
      token = req.query['token'];
    }
    if (!token) throw new UnauthorizedException('Admin token required');

    try {
      const payload = this.jwt.verify<{ sub: string; role?: string }>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      if (payload.role !== 'SUPER_ADMIN') {
        throw new ForbiddenException('SUPER_ADMIN required');
      }
      next();
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new UnauthorizedException('Invalid admin token');
    }
  }
}
