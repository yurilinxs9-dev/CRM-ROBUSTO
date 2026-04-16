import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

interface ErrorBody {
  error: string;
  message: string;
  code: string;
  statusCode: number;
  requestId?: string;
  path: string;
  timestamp: string;
  details?: unknown;
}

/**
 * Global catch-all filter. Produces a stable error envelope, never leaks
 * stack traces or raw Prisma/Zod internals in production.
 * Order of specificity matters — most filters register this as the LAST
 * (catch-all) entry; Zod and Prisma filters run first for their types.
 */
@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const isProd = process.env.NODE_ENV === 'production';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errorLabel = 'InternalServerError';
    let code = 'INTERNAL_ERROR';
    let details: unknown = undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      errorLabel = 'Bad Request';
      code = 'VALIDATION_ERROR';
      message = 'Validation failed';
      details = exception.issues.map((i) => ({ path: i.path, message: i.message, code: i.code }));
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrisma(exception);
      status = mapped.status;
      errorLabel = mapped.errorLabel;
      code = mapped.code;
      message = mapped.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      errorLabel = HttpStatus[status] ?? 'HttpException';
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
      } else if (resp && typeof resp === 'object') {
        const r = resp as Record<string, unknown>;
        message = (r['message'] as string) ?? exception.message;
        if (typeof r['error'] === 'string') errorLabel = r['error'];
      } else {
        message = exception.message;
      }
      code = this.httpStatusToCode(status);
    } else if (exception instanceof Error) {
      message = isProd ? 'Internal server error' : exception.message;
    }

    const body: ErrorBody = {
      error: errorLabel,
      message,
      code,
      statusCode: status,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? undefined,
      path: req.url,
      timestamp: new Date().toISOString(),
    };
    if (details !== undefined) body.details = details;

    // Log at appropriate level. 5xx = error, 4xx = warn.
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${status} ${code}`, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(`${req.method} ${req.url} -> ${status} ${code} ${message}`);
    }

    res.status(status).json(body);
  }

  private mapPrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number; errorLabel: string; code: string; message: string;
  } {
    switch (e.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          errorLabel: 'Conflict',
          code: 'UNIQUE_CONSTRAINT',
          message: 'Resource already exists',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          errorLabel: 'Not Found',
          code: 'NOT_FOUND',
          message: 'Resource not found',
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          errorLabel: 'Bad Request',
          code: 'FOREIGN_KEY_VIOLATION',
          message: 'Referenced resource does not exist',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          errorLabel: 'Database Error',
          code: `PRISMA_${e.code}`,
          message: 'Database error',
        };
    }
  }

  private httpStatusToCode(status: number): string {
    if (status === 400) return 'BAD_REQUEST';
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status === 413) return 'PAYLOAD_TOO_LARGE';
    if (status === 422) return 'UNPROCESSABLE_ENTITY';
    if (status === 429) return 'TOO_MANY_REQUESTS';
    if (status === 502) return 'BAD_GATEWAY';
    if (status === 503) return 'SERVICE_UNAVAILABLE';
    return `HTTP_${status}`;
  }
}
