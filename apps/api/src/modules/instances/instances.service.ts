import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import type { AuthUser } from '../../common/types/auth-user';

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

export interface UazApiStatusResponse {
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

  private async loadInstanceTokenScoped(nome: string, tenantId: string): Promise<string> {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: tenantId },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException(`Token UazAPI ausente para instancia ${nome}`);
    return token;
  }

  async findAll(user: AuthUser) {
    return this.prisma.whatsappInstance.findMany({
      where: { tenant_id: user.tenantId },
      orderBy: { created_at: 'asc' },
    });
  }

  async create(nome: string, user: AuthUser) {
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
          events: ['messages', 'messages_update', 'connection', 'presence', 'contacts', 'chats'],
          addUrlEvents: false,
          addUrlTypesMessages: false,
          excludeMessages: [],
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
        owner_user_id: user.id,
        tenant_id: user.tenantId,
      },
      update: {
        status: 'connecting',
        config: { uazapi_token, uazapi_id },
      },
    });

    return { instanceName: nome, status: 'connecting' };
  }

  async getQrCode(nome: string, user: AuthUser) {
    const token = await this.loadInstanceTokenScoped(nome, user.tenantId);
    const { data } = await firstValueFrom(
      this.http.post<UazApiConnectResponse & { connected?: boolean }>(
        `${this.baseUrl}/instance/connect`,
        {},
        { headers: this.headers(token) },
      ),
    );
    const qrcode = data.instance?.qrcode ?? null;
    const isConnected =
      data.status?.connected === true ||
      data.status?.loggedIn === true ||
      (data as { connected?: boolean }).connected === true ||
      data.instance?.status === 'connected';
    if (isConnected || !qrcode) {
      const jid = data.status?.jid ?? null;
      const telefone = jid ? jid.split('@')[0].split(':')[0] : undefined;
      await this.prisma.whatsappInstance.update({
        where: { nome },
        data: {
          status: 'open',
          ultimo_check: new Date(),
          ...(telefone ? { telefone } : {}),
        },
      });
      return { base64: null, alreadyConnected: true };
    }
    return { base64: qrcode, alreadyConnected: false };
  }

  async reconnect(nome: string, user: AuthUser) {
    return this.getQrCode(nome, user);
  }

  async checkStatus(nome: string, user: AuthUser) {
    const token = await this.loadInstanceTokenScoped(nome, user.tenantId);
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

  async fetchProfile(
    token: string,
    number: string,
  ): Promise<{ name?: string; imageUrl?: string }> {
    if (!token || !number) return {};
    try {
      const { data } = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.baseUrl}/chat/GetNameAndImageURL`,
          { number, preview: false },
          { headers: this.headers(token), timeout: 15000 },
        ),
      );
      // UazAPI returns: { name, wa_name, wa_contactName, image, imagePreview, ... }
      // Prefer the real WhatsApp contact/profile name over any local labels.
      const name =
        (data?.wa_contactName as string | undefined) ??
        (data?.wa_name as string | undefined) ??
        (data?.name as string | undefined) ??
        (data?.pushName as string | undefined) ??
        (data?.verifiedName as string | undefined);
      const imageUrl =
        (data?.image as string | undefined) ??
        (data?.imagePreview as string | undefined) ??
        (data?.imageUrl as string | undefined) ??
        (data?.profilePictureUrl as string | undefined);
      return {
        name: name && name.trim() ? name.trim() : undefined,
        imageUrl: imageUrl && imageUrl.trim() ? imageUrl.trim() : undefined,
      };
    } catch (err) {
      this.logger.warn(`fetchProfile falhou para ${number}: ${String(err)}`);
      return {};
    }
  }

  async delete(nome: string, user: AuthUser) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome, tenant_id: user.tenantId },
    });
    if (!instance) throw new NotFoundException(`Instancia ${nome} nao encontrada`);
    const cfg = (instance.config ?? {}) as InstanceConfig;
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
