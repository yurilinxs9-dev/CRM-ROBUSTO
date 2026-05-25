import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('outbound-webhooks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OutboundWebhooksController {
  constructor(private readonly svc: OutboundWebhooksService) {}

  private tenantId(req: Record<string, unknown>): string {
    return (req.user as AuthUser).tenantId;
  }

  @Get()
  @Roles(UserRole.GERENTE)
  list(@Req() req: Record<string, unknown>) {
    return this.svc.list(this.tenantId(req));
  }

  @Get(':id')
  @Roles(UserRole.GERENTE)
  get(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.svc.get(this.tenantId(req), id);
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.svc.create(this.tenantId(req), body);
  }

  @Patch(':id')
  @Roles(UserRole.GERENTE)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.svc.update(this.tenantId(req), id, body);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  delete(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.svc.delete(this.tenantId(req), id);
  }

  @Post(':id/test')
  @Roles(UserRole.GERENTE)
  test(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.svc.test(this.tenantId(req), id);
  }

  @Get(':id/deliveries')
  @Roles(UserRole.GERENTE)
  deliveries(
    @Param('id') id: string,
    @Req() req: Record<string, unknown>,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listDeliveries(this.tenantId(req), id, limit ? parseInt(limit) : 100);
  }
}
