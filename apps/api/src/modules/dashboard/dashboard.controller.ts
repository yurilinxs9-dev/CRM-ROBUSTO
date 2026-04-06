import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('stats')
  getStats(@Req() req: Record<string, unknown>) {
    return this.dashboardService.getStats(req.user as AuthUser);
  }

  @Get('funnel')
  getFunnel(@Req() req: Record<string, unknown>, @Query('pipelineId') pipelineId?: string) {
    return this.dashboardService.getFunnel(req.user as AuthUser, pipelineId);
  }

  @Get('performance')
  getPerformance(@Req() req: Record<string, unknown>) {
    return this.dashboardService.getPerformance(req.user as AuthUser);
  }

  @Get('volume')
  getVolume(@Req() req: Record<string, unknown>) {
    return this.dashboardService.getVolume(req.user as AuthUser);
  }
}
