import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';

interface UazApiCreateResponse {
  instance: {
    id: string;
    token: string;
    name: string;
    status: string;
    qrcode?: string;
  };
}

interface UazApiConnectResponse {
  instance: {
    qrcode?: string;
    status: string;
  };
  status: {
    connected: boolean;
    loggedIn: boolean;
    jid: string | null;
  };
}

interface UazApiStatusResponse {
  instance: {
    status: string;
    profileName?: string;
    owner?: string;
    qrcode?: string;
  };
  status: {
    connected: boolean;
    loggedIn: boolean;
    jid: string | null;
  };
}

interface InstanceConfig {
  uazapi_token?: string;
  uazapi_id?: string;
  [key: string]: unknown;
}

@Injectable()
export class InstancesService {
  private readonly logger = new Logger(InstancesService.name);
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly webhookUrl: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.adminToken = this.config.get<string>('UAZAPI_ADMIN_TOKEN', '');
    const publicUrl = this.config.get<string>('WEBHOOK_PUBLIC_URL', 'http://crm-backend:3001');
    this.webhookUrl = `${publicUrl}/api/webhook/uazapi`;
  }

  private headers(instanceToken: string): Record<string, string> {
    return { token: instanceToken };
  }

  private adminHeaders(): Record<string, string> {
    return { admintoken: this.adminToken };
  }

  private async loadInstanceToken(nome: string): Promise<string> {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { nome } });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException(`Token UazAPI ausente para instancia ${nome}`);
    return token;
  }

  async findAll() {
    return this.prisma.whatsappInstance.findMany({
      orderBy: { created_at: 'asc' },
    });
  }

  async create(nome: string) {
    const { data: createData } = await firstValueFrom(
      this.http.post<UazApiCreateResponse>(
        `${this.baseUrl}/instance/create`,
        { name: nome },
        { headers: this.adminHeaders() },
      ),
    );

    const uazapi_token = createData.instance.token;
    const uazapi_id = createData.instance.id;

    await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/webhook`,
        {
          url: this.webhookUrl,
          enabled: true,
          events: ['message', 'message_ack', 'connection_update'],
        },
        { headers: this.headers(uazapi_token) },
      ),
    ).catch((err: unknown) => {
      this.logger.warn(`Falha ao registrar webhook UazAPI para ${nome}: ${String(err)}`);
      return null;
    });

    await this.prisma.whatsappInstance.upsert({
      where: { nome },
      create: {
        nome,
        status: 'connecting',
        config: { uazapi_token, uazapi_id },
      },
      update: {
        status: 'connecting',
        config: { uazapi_token, uazapi_id },
      },
    });

    return { instanceName: nome, status: 'connecting' };
  }

  async getQrCode(nome: string) {
    const token = await this.loadInstanceToken(nome);
    const { data } = await firstValueFrom(
      this.http.post<UazApiConnectResponse>(
        `${this.baseUrl}/instance/connect`,
        {},
        { headers: this.headers(token) },
      ),
    );
    return { base64: data.instance?.qrcode ?? null };
  }

  async reconnect(nome: string) {
    return this.getQrCode(nome);
  }

  async checkStatus(nome: string) {
    const token = await this.loadInstanceToken(nome);
    const { data } = await firstValueFrom(
      this.http.get<UazApiStatusResponse>(`${this.baseUrl}/instance/status`, {
        headers: this.headers(token),
      }),
    );

    const rawStatus = data.instance?.status ?? 'disconnected';
    const statusMap: Record<string, string> = {
      connected: 'open',
      connecting: 'connecting',
      disconnected: 'disconnected',
    };
    const status = statusMap[rawStatus] ?? rawStatus;

    const jid = data.status?.jid ?? null;
    const telefone = jid ? jid.split('@')[0].split(':')[0] : undefined;

    await this.prisma.whatsappInstance.update({
      where: { nome },
      data: {
        status,
        ultimo_check: new Date(),
        ...(telefone ? { telefone } : {}),
      },
    });
    return data;
  }

  async delete(nome: string) {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { nome } });
    const cfg = (instance?.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;

    if (token) {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl}/instance`, {
          headers: { ...this.adminHeaders(), ...this.headers(token) },
        }),
      ).catch((err: unknown) => {
        this.logger.warn(`Falha ao deletar instancia UazAPI ${nome}: ${String(err)}`);
        return null;
      });
    }

    await this.prisma.whatsappInstance.delete({ where: { nome } }).catch((err: unknown) => {
      this.logger.warn(`Falha ao deletar instancia DB ${nome}: ${String(err)}`);
      return null;
    });
  }
}
