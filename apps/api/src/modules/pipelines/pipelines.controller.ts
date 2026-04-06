import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { PipelinesService } from './pipelines.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PipelinesController {
  constructor(private pipelinesService: PipelinesService) {}

  @Get('pipelines')
  findAll() {
    return this.pipelinesService.findAll();
  }

  @Get('pipelines/:id')
  findOne(@Param('id') id: string) {
    return this.pipelinesService.findOne(id);
  }

  @Post('pipelines')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  create(@Body() body: unknown) {
    return this.pipelinesService.create(body);
  }

  @Patch('pipelines/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.pipelinesService.update(id, body);
  }

  @Delete('pipelines/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  remove(@Param('id') id: string) {
    return this.pipelinesService.remove(id);
  }

  @Post('pipelines/:id/stages')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  createStage(@Param('id') id: string, @Body() body: unknown) {
    return this.pipelinesService.createStage(id, body);
  }

  @Post('pipelines/:id/stages/reorder')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  reorderStages(@Param('id') id: string, @Body() body: unknown) {
    return this.pipelinesService.reorderStages(id, body);
  }

  @Patch('stages/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  updateStage(@Param('id') id: string, @Body() body: unknown) {
    return this.pipelinesService.updateStage(id, body);
  }

  @Delete('stages/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.GERENTE)
  removeStage(@Param('id') id: string) {
    return this.pipelinesService.removeStage(id);
  }
}
