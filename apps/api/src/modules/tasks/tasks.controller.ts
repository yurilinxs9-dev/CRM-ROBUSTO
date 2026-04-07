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
  Res,
  UseGuards,
} from '@nestjs/common';
import { TasksService, type TaskFilters, type ExportTaskFilters } from './tasks.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';
import type { Response } from 'express';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>, @Query() filters: TaskFilters) {
    return this.tasks.findAll(req.user as AuthUser, filters);
  }

  @Get('today')
  findToday(@Req() req: Record<string, unknown>) {
    return this.tasks.findToday(req.user as AuthUser);
  }

  @Get('upcoming')
  findUpcoming(@Req() req: Record<string, unknown>) {
    return this.tasks.findUpcoming(req.user as AuthUser);
  }

  @Get('overdue')
  findOverdue(@Req() req: Record<string, unknown>) {
    return this.tasks.findOverdue(req.user as AuthUser);
  }

  @Get('export')
  exportCsv(
    @Req() req: Record<string, unknown>,
    @Res() res: Response,
    @Query() filters: ExportTaskFilters,
  ) {
    return this.tasks.exportCsv(req.user as AuthUser, filters, res);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.tasks.findOne(id, req.user as AuthUser);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.tasks.create(body, req.user as AuthUser);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.tasks.update(id, body, req.user as AuthUser);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.tasks.remove(id, req.user as AuthUser);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.tasks.complete(id, req.user as AuthUser);
  }
}
