import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const sendTextSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
});

const internalNoteSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
});

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiUrl = config.get('EVOLUTION_API_URL_INTERNAL', 'http://evolution-api:8080') || 'http://evolution-api:8080';
    this.apiKey = config.get('EVOLUTION_API_KEY', '') || '';
  }

  async sendText(data: unknown, userId: string) {
    const { lead_id, content } = sendTextSchema.parse(data);

    const lead = await this.prisma.lead.findUnique({ where: { id: lead_id } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    const remoteJid = `${lead.telefone}@s.whatsapp.net`;

    const { data: response } = await firstValueFrom(
      this.http.post(
        `${this.apiUrl}/message/sendText/${lead.instancia_whatsapp}`,
        { number: remoteJid, text: content },
        { headers: { apikey: this.apiKey } },
      ),
    );

    const responseData = response as Record<string, unknown>;
    const keyData = responseData?.key as Record<string, unknown> | undefined;
    const whatsappMessageId = (keyData?.id as string) || uuid();

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: whatsappMessageId,
        direction: 'OUTGOING',
        type: 'TEXT',
        content,
        status: 'SENT',
        sent_by_user_id: userId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    return message;
  }

  async createInternalNote(data: unknown, userId: string) {
    const { lead_id, content } = internalNoteSchema.parse(data);
    return this.prisma.message.create({
      data: {
        lead_id,
        instance_name: 'internal',
        whatsapp_message_id: uuid(),
        direction: 'OUTGOING',
        type: 'TEXT',
        content,
        status: 'READ',
        is_internal_note: true,
        sent_by_user_id: userId,
      },
    });
  }

  async getHistory(leadId: string, cursor?: string, limit = 50) {
    return this.prisma.message.findMany({
      where: { lead_id: leadId },
      orderBy: { created_at: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}
