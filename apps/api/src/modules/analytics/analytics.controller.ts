import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.analyticsService.getOverview(req.user as AuthUser, query);
  }

  @Get('funnel')
  getFunnel(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.analyticsService.getFunnel(req.user as AuthUser, query);
  }

  @Get('conversion')
  getConversion(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.analyticsService.getConversion(req.user as AuthUser, query);
  }

  @Get('time-in-stage')
  getTimeInStage(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.analyticsService.getTimeInStage(req.user as AuthUser, query);
  }

  @Get('performance')
  getPerformance(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.analyticsService.getPerformance(req.user as AuthUser, query);
  }
}
