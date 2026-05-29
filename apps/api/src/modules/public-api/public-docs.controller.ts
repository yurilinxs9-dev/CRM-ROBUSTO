import { Controller, Get, Header } from '@nestjs/common';
import { openApiSpec } from './openapi';

/**
 * Spec OpenAPI público (sem auth) — para import no Postman/Insomnia e SDK gen.
 * Rota: GET /api/v1/openapi.json
 */
@Controller('v1')
export class PublicDocsController {
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  spec() {
    return openApiSpec;
  }
}
