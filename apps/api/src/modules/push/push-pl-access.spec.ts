import { PushService } from './push.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import * as webpush from 'web-push';
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn().mockResolvedValue(undefined) }));
const tenant = 'a44772ed-1382-4400-84fc-3fa350e23e42';
const lead = '369354c4-b4d6-4bb1-93c0-0afeedc1450e';
describe('push restrito PL', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([null, 'other', 'seller'])('entrega mensagem apenas ao responsável atual (%s)', async owner => {
    const prisma = { pushSubscription: { findMany: jest.fn().mockResolvedValue([
      { user_id: 'seller', endpoint: 'seller-endpoint', p256dh: 'x', auth: 'x', user: { tenant_id: tenant, role: 'OPERADOR', pl_sales_only: true } },
      { user_id: 'manager', endpoint: 'manager-endpoint', p256dh: 'x', auth: 'x', user: { tenant_id: tenant, role: 'GERENTE', pl_sales_only: false } },
    ]) }, lead: { findFirst: jest.fn().mockResolvedValue({ responsavel_id: owner }) } };
    const service = new PushService({ get: () => 'configured' } as unknown as ConfigService, prisma as unknown as PrismaService);
    service.onModuleInit();
    await service.sendToUsers(['seller', 'manager'], { title: 'Cliente', body: 'mensagem', url: `/chat/${lead}` });
    const endpoints = jest.mocked(webpush.sendNotification).mock.calls.map(call => call[0].endpoint);
    expect(endpoints).toEqual(owner === 'seller' ? ['seller-endpoint', 'manager-endpoint'] : ['manager-endpoint']);
  });
});
