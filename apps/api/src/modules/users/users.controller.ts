import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @Roles('GERENTE' as any)
  findAll() {
    return this.usersService.findAll();
  }

  @Get('list')
  findAllForTenant(@Req() req: Record<string, unknown>) {
    return this.usersService.findAllForTenant(req.user as AuthUser);
  }
}
