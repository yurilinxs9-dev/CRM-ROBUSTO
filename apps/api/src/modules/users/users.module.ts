import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SectorsModule } from '../sectors/sectors.module';

@Module({
  imports: [SectorsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
