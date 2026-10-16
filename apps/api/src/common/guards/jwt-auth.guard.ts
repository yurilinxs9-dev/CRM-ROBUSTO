import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PlSalesPolicyService } from '../access/pl-sales-policy.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector, private readonly policy: PlSalesPolicyService) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const authenticated = await super.canActivate(context);
    if (!authenticated) return false;
    await this.policy.assertAllowed(context.switchToHttp().getRequest());
    return true;
  }

  handleRequest<TUser>(err: Error | null, user: TUser): TUser {
    if (err || !user) throw err || new UnauthorizedException();
    return user;
  }
}
