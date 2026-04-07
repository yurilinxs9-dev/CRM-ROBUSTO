import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PipelinesService } from './pipelines.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller()
@UseGuards(JwtAuthGuard)
export class PipelinesController {
  constructor(private pipelinesService: PipelinesService) {}

  @Get('pipelines')
  findAll(
    @Req() req: Record<string, unknown>,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.pipelinesService.findAll(
      req.user as AuthUser,
      includeArchived === 'true' || includeArchived === '1',
    );
  }

  @Get('pipelines/:id')
  findOne(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.findOne(id, req.user as AuthUser);
  }

  @Post('pipelines')
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.create(body, req.user as AuthUser);
  }

  @Post('pipelines/reorder')
  reorderPipelines(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.reorderPipelines(body, req.user as AuthUser);
  }

  @Patch('pipelines/:id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.update(id, body, req.user as AuthUser);
  }

  @Delete('pipelines/:id')
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.remove(id, req.user as AuthUser);
  }

  @Post('pipelines/:id/duplicate')
  duplicate(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.duplicate(id, req.user as AuthUser);
  }

  @Post('pipelines/:id/archive')
  archive(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.archive(id, req.user as AuthUser);
  }

  @Post('pipelines/:id/unarchive')
  unarchive(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.unarchive(id, req.user as AuthUser);
  }

  @Post('pipelines/:id/delete-with-move')
  deleteWithMove(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    return this.pipelinesService.deleteWithMoveLeads(id, body, req.user as AuthUser);
  }

  @Post('pipelines/:id/stages')
  createStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.createStage(id, body, req.user as AuthUser);
  }

  @Post('pipelines/:id/stages/reorder')
  reorderStages(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.reorderStages(id, body, req.user as AuthUser);
  }

  @Patch('stages/:id')
  updateStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.updateStage(id, body, req.user as AuthUser);
  }

  @Delete('stages/:id')
  removeStage(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.pipelinesService.removeStage(id, req.user as AuthUser);
  }
}
