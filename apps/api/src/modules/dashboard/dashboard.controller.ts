import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('stats')
  @Roles('GERENTE' as any)
  getStats() {
    return this.dashboardService.getStats();
  }

  @Get('funnel')
  @Roles('GERENTE' as any)
  getFunnel(@Query('pipelineId') pipelineId?: string) {
    return this.dashboardService.getFunnel(pipelineId);
  }

  @Get('performance')
  @Roles('GERENTE' as any)
  getPerformance() {
    return this.dashboardService.getPerformance();
  }

  @Get('volume')
  @Roles('GERENTE' as any)
  getVolume() {
    return this.dashboardService.getVolume();
  }
}
