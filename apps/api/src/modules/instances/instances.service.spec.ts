import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import { InstancesService } from './instances.service';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { HistorySyncService } from '../webhooks/history-sync.service';

const ENV: Record<string, string> = {
  UAZAPI_BASE_URL: 'https://uazapi.test',
  UAZAPI_ADMIN_TOKEN: 'admin-token',
  WEBHOOK_PUBLIC_URL: 'https://crm.test',
  EVOLUTION_BASE_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: 'global-key',
};

function makeService(overrides: {
  instances: Array<Record<string, unknown>>;
  httpGet?: jest.Mock;
  httpPost?: jest.Mock;
}) {
  const httpGet = overrides.httpGet ?? jest.fn();
  const httpPost = overrides.httpPost ?? jest.fn().mockReturnValue(of({ data: {} }));
  const http = { get: httpGet, post: httpPost } as unknown as HttpService;
  const config = {
    get: (key: string, def?: string) => ENV[key] ?? def,
  } as unknown as ConfigService;
  const prisma = {
    whatsappInstance: {
      findMany: jest.fn().mockResolvedValue(overrides.instances),
    },
  } as unknown as PrismaService;
  const historySync = {} as HistorySyncService;
  const service = new InstancesService(http, config, prisma, historySync);
  return { service, httpGet, httpPost };
}

describe('InstancesService.syncAllWebhookUrls — instâncias Evolution', () => {
  const evoInstance = {
    id: 'inst-1',
    nome: 'teste',
    webhook_secret: null,
    config: { provider: 'evolution', evolution_token: 'evo-key-1' },
  };

  it('re-aponta webhook Evolution sequestrado de volta pro CRM', async () => {
    const { service, httpPost } = makeService({
      instances: [evoInstance],
      httpGet: jest.fn().mockReturnValue(
        of({
          data: {
            url: 'https://outro-sistema.example/functions/v1/whatsapp-webhook',
            enabled: true,
            events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
          },
        }),
      ),
    });

    const result = await service.syncAllWebhookUrls();

    expect(result.updated).toBe(1);
    expect(httpPost).toHaveBeenCalledWith(
      'http://evolution:8080/webhook/set/teste',
      expect.objectContaining({
        webhook: expect.objectContaining({
          enabled: true,
          url: 'https://crm.test/api/webhook/evolution',
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ apikey: 'evo-key-1' }),
      }),
    );
  });

  it('não mexe quando webhook Evolution já aponta pro CRM com eventos certos', async () => {
    const { service, httpPost } = makeService({
      instances: [evoInstance],
      httpGet: jest.fn().mockReturnValue(
        of({
          data: {
            url: 'https://crm.test/api/webhook/evolution',
            enabled: true,
            events: [
              'MESSAGES_UPSERT',
              'MESSAGES_UPDATE',
              'CONNECTION_UPDATE',
              'CONTACTS_UPSERT',
              'CHATS_UPDATE',
            ],
          },
        }),
      ),
    });

    const result = await service.syncAllWebhookUrls();

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('registra webhook quando Evolution responde 404 (nenhum webhook setado)', async () => {
    const err = new AxiosError('Not Found');
    err.response = { status: 404 } as never;
    const { service, httpPost } = makeService({
      instances: [evoInstance],
      httpGet: jest.fn().mockReturnValue(throwError(() => err)),
    });

    const result = await service.syncAllWebhookUrls();

    expect(result.updated).toBe(1);
    expect(httpPost).toHaveBeenCalledWith(
      'http://evolution:8080/webhook/set/teste',
      expect.anything(),
      expect.anything(),
    );
  });

  it('pula instância Evolution com token revogado (401)', async () => {
    const err = new AxiosError('Unauthorized');
    err.response = { status: 401 } as never;
    const { service, httpPost } = makeService({
      instances: [evoInstance],
      httpGet: jest.fn().mockReturnValue(throwError(() => err)),
    });

    const result = await service.syncAllWebhookUrls();

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();
  });
});

/**
 * Deep sync manual: o endpoint aceita `deep` e o service repassa pro
 * HistorySyncService — é o modo que varre o MIOLO das conversas (o normal só
 * enxerga buraco no fim do chat).
 */
describe('InstancesService.startHistorySync — modo deep', () => {
  function makeWithSync(config: Record<string, unknown>) {
    const syncInstance = jest.fn().mockResolvedValue({});
    const syncEvolutionInstance = jest.fn().mockResolvedValue({});
    const http = { get: jest.fn(), post: jest.fn() } as unknown as HttpService;
    const cfg = { get: (k: string, d?: string) => ENV[k] ?? d } as unknown as ConfigService;
    const prisma = {
      whatsappInstance: {
        findFirst: jest.fn().mockResolvedValue({ id: 'inst-1', config }),
      },
    } as unknown as PrismaService;
    const historySync = { syncInstance, syncEvolutionInstance } as unknown as HistorySyncService;
    const service = new InstancesService(http, cfg, prisma, historySync);
    return { service, syncInstance, syncEvolutionInstance };
  }

  const user = { tenantId: 't1' } as never;

  it('deep=true chega no sync UazAPI e volta no retorno do endpoint', async () => {
    const m = makeWithSync({ uazapi_token: 'tok' });

    const r = await m.service.startHistorySync('isamara', 2, true, user);

    expect(m.syncInstance).toHaveBeenCalledWith('inst-1', 2 * 24 * 3_600_000, true);
    expect(r).toEqual({ started: true, days: 2, deep: true });
  });

  it('sem deep o sync continua no modo normal (Evolution)', async () => {
    const m = makeWithSync({ provider: 'evolution' });

    const r = await m.service.startHistorySync('teste', 30, false, user);

    expect(m.syncEvolutionInstance).toHaveBeenCalledWith('inst-1', 30 * 24 * 3_600_000, false);
    expect(r).toEqual({ started: true, days: 30, deep: false });
  });
});
