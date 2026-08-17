import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AttributionService } from './attribution.service';

/**
 * Pixel de clique. Público e sem autenticação — roda no site do cliente, que é
 * outra origem.
 *
 * É `<img>` e não `fetch` por um motivo específico: requisição de imagem não
 * manda header `Origin`, então passa direto pela política de CORS do main.ts
 * (que só libera o FRONTEND_URL) sem precisar afrouxá-la. Trocar por fetch
 * exigiria mexer no CORS global — justamente o tipo de mudança que quebra o
 * que já funciona.
 */
@Controller('track')
export class TrackController {
  constructor(private readonly svc: AttributionService) {}

  /** GIF transparente de 1x1. O menor corpo possível que um <img> aceita. */
  private static readonly PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );

  @Get('c')
  async click(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    // O pixel responde SEMPRE 200, aconteça o que acontecer no banco: um erro
    // aqui não pode virar imagem quebrada na página do cliente.
    await this.svc.registerClick(query).catch(() => undefined);

    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': String(TrackController.PIXEL.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.status(200).send(TrackController.PIXEL);
  }
}
