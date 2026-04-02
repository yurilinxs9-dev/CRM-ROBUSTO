import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('pipelines')
@UseGuards(JwtAuthGuard)
export class PipelinesController {
  constructor(private pipelinesService: PipelinesService) {}

  @Get()
  findAll() {
    return this.pipelinesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pipelinesService.findOne(id);
  }
}
