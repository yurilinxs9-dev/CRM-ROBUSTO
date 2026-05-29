import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

const STATUS_LABEL: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * Filtro de erros EXCLUSIVO da API pública (/api/v1). Produz o envelope
 * { error, message } definido no contrato externo — separado do
 * AllExceptionFilter interno (que o frontend consome com outro formato).
 * Aplicado via @UseFilters no PublicApiController.
 */
@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PublicApi');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message = 'Erro interno no servidor.';

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      error = 'Bad Request';
      message =
        exception.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; ') || 'Estrutura do JSON inválida ou dados faltando.';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        error = 'Not Found';
        message = 'Recurso não encontrado.';
      } else if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        error = 'Conflict';
        message = 'Recurso já existe.';
      } else {
        status = HttpStatus.BAD_REQUEST;
        error = 'Bad Request';
        message = 'Erro ao processar a requisição no banco de dados.';
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = STATUS_LABEL[status] ?? 'Error';
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
      } else if (resp && typeof resp === 'object') {
        const r = resp as Record<string, unknown>;
        if (typeof r['message'] === 'string') message = r['message'];
        else if (Array.isArray(r['message'])) message = (r['message'] as string[]).join('; ');
        else message = exception.message;
        if (typeof r['error'] === 'string') error = r['error'];
      } else {
        message = exception.message;
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} -> ${status} ${message}`);
    }

    res.status(status).json({ error, message });
  }
}
