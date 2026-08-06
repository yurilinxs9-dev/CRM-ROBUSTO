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
import { ContactsService } from './contacts.service';
import { CompaniesService } from './companies.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('contacts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContactsController {
  constructor(private contacts: ContactsService) {}

  @Get()
  list(@Req() req: Record<string, unknown>, @Query('q') q?: string) {
    return this.contacts.list(req.user as AuthUser, q);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.contacts.get(id, req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.OPERADOR)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.contacts.create(body, req.user as AuthUser);
  }

  @Patch(':id')
  @Roles(UserRole.OPERADOR)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.contacts.update(id, body, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.contacts.remove(id, req.user as AuthUser);
  }
}

@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private companies: CompaniesService) {}

  @Get()
  list(@Req() req: Record<string, unknown>, @Query('q') q?: string) {
    return this.companies.list(req.user as AuthUser, q);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.companies.get(id, req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.OPERADOR)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.companies.create(body, req.user as AuthUser);
  }

  @Patch(':id')
  @Roles(UserRole.OPERADOR)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.companies.update(id, body, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.companies.remove(id, req.user as AuthUser);
  }
}

/** Vínculo lead <-> contato. Rota aninhada porque o vínculo pertence ao lead. */
@Controller('leads/:leadId/contacts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadContactsController {
  constructor(private contacts: ContactsService) {}

  @Get()
  list(@Param('leadId') leadId: string, @Req() req: Record<string, unknown>) {
    return this.contacts.listByLead(leadId, req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.OPERADOR)
  link(
    @Param('leadId') leadId: string,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    return this.contacts.link(leadId, body, req.user as AuthUser);
  }

  @Delete(':contactId')
  @Roles(UserRole.OPERADOR)
  unlink(
    @Param('leadId') leadId: string,
    @Param('contactId') contactId: string,
    @Req() req: Record<string, unknown>,
  ) {
    return this.contacts.unlink(leadId, contactId, req.user as AuthUser);
  }
}
