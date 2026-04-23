import {
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const updateProfileSchema = z.object({
  nome: z.string().min(2).max(100).optional(),
  titulo: z.string().max(50).nullable().optional(),
  especialidade: z.string().max(100).nullable().optional(),
});

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @Roles(UserRole.GERENTE)
  findAll(@Req() req: Record<string, unknown>) {
    return this.usersService.findAll(req.user as AuthUser);
  }

  @Get('list')
  findAllForTenant(@Req() req: Record<string, unknown>) {
    return this.usersService.findAllForTenant(req.user as AuthUser);
  }

  @Patch('me')
  updateProfile(@Req() req: Record<string, unknown>, @Body() body: unknown) {
    const dto = updateProfileSchema.parse(body);
    return this.usersService.updateProfile(req.user as AuthUser, dto);
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  uploadAvatar(
    @Req() req: Record<string, unknown>,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.usersService.uploadAvatar(req.user as AuthUser, file);
  }
}
