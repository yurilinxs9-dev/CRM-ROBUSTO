import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class InstancesService {
  private readonly logger = new Logger(InstancesService.name);
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

  private get headers() {
    return { apikey: this.apiKey };
  }

  async findAll() {
    return this.prisma.whatsappInstance.findMany({
      orderBy: { created_at: 'asc' },
    });
  }

  async create(nome: string) {
    const { data } = await firstValueFrom(
      this.http.post(`${this.apiUrl}/instance/create`, {
        instanceName: nome,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }, { headers: this.headers }),
    );

    await this.prisma.whatsappInstance.upsert({
      where: { nome },
      create: { nome, status: 'connecting' },
      update: { status: 'connecting' },
    });

    return data;
  }

  async getQrCode(nome: string) {
    const { data } = await firstValueFrom(
      this.http.get(`${this.apiUrl}/instance/connect/${nome}`, { headers: this.headers }),
    );
    return data;
  }

  async reconnect(nome: string) {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/instance/logout/${nome}`, { headers: this.headers }),
    ).catch(() => null);

    return this.getQrCode(nome);
  }

  async checkStatus(nome: string) {
    const { data } = await firstValueFrom(
      this.http.get(`${this.apiUrl}/instance/connectionState/${nome}`, { headers: this.headers }),
    );
    const instanceData = data?.instance as Record<string, unknown> | undefined;
    await this.prisma.whatsappInstance.update({
      where: { nome },
      data: { status: (instanceData?.state as string) || 'disconnected', ultimo_check: new Date() },
    });
    return data;
  }
}
