import { InboundMessageService } from './inbound-message.service';
import { MessagesSendProcessor } from '../messages/messages.processor';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';
import type { AuthUser } from '../../common/types/auth-user';
import type { Job } from 'bullmq';
import { of } from 'rxjs';
import type { SendTextJobData } from '../messages/messages.queue';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task 4 — tenant suspenso (`Tenant.suspended_at`) para de trabalhar dos dois
 * lados: o inbound descarta a mensagem (a instância "some" pros handlers) e o
 * job de envio é jogado fora antes de bater no gateway de WhatsApp.
 *
 * Os stubs de dependência do InboundMessageService seguem o padrão do
 * `inbound-message.service.spec.ts` (mesma ordem do construtor).
 */

// ── InboundMessageService ────────────────────────────────────────────────────

/** Mesmo conjunto de stubs de `inbound-message.service.spec.ts`, reduzido ao
 *  que os finders tocam (só `prisma.whatsappInstance.findFirst`) — os demais
 *  colaboradores entram como objetos vazios porque nenhum finder os usa. */
function makeInbound(instanceRow: unknown) {
  const prisma: any = {
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(instanceRow) },
  };
  const service = new InboundMessageService(
    prisma,
    {} as any, // leadsService
    {} as any, // gateway
    {} as any, // mediaService
    {} as any, // mediaPipeline
    {} as any, // push
    {} as any, // outboundWebhooks
    {} as any, // assignment
    {} as any, // conversations
    {} as any, // broadcastReply
    {} as any, // attribution
  );
  return { service, prisma };
}

const instanceRow = (suspendedAt: Date | null) => ({
  id: 'i1',
  tenant_id: 't1',
  nome: 'x',
  config: { provider: 'evolution', uazapi_token: 'tok' },
  tenant: { suspended_at: suspendedAt },
});

describe('inbound de tenant suspenso', () => {
  it('findEvolutionInstanceByName retorna null quando tenant.suspended_at setado', async () => {
    const { service } = makeInbound(instanceRow(new Date()));
    await expect(service.findEvolutionInstanceByName('x')).resolves.toBeNull();
  });

  it('findEvolutionInstanceByName resolve normal quando suspended_at null', async () => {
    const { service } = makeInbound(instanceRow(null));
    await expect(service.findEvolutionInstanceByName('x')).resolves.toMatchObject({ id: 'i1' });
  });

  it('findInstanceByName retorna null quando tenant suspenso', async () => {
    const { service } = makeInbound(instanceRow(new Date()));
    await expect(service.findInstanceByName('x')).resolves.toBeNull();
  });

  it('findInstanceByName resolve normal quando suspended_at null', async () => {
    const { service } = makeInbound(instanceRow(null));
    await expect(service.findInstanceByName('x')).resolves.toMatchObject({ id: 'i1' });
  });

  it('findInstanceByUazapiToken retorna null quando tenant suspenso', async () => {
    const { service } = makeInbound(instanceRow(new Date()));
    await expect(service.findInstanceByUazapiToken('tok')).resolves.toBeNull();
  });

  it('findInstanceByUazapiToken resolve normal quando suspended_at null', async () => {
    const { service } = makeInbound(instanceRow(null));
    await expect(service.findInstanceByUazapiToken('tok')).resolves.toMatchObject({ id: 'i1' });
  });

  it('os finders carregam suspended_at do tenant na query (senão o guard nunca dispara)', async () => {
    const { service, prisma } = makeInbound(instanceRow(null));
    await service.findInstanceByName('x');
    const arg = prisma.whatsappInstance.findFirst.mock.calls[0][0];
    const rel = arg.include?.tenant ?? arg.select?.tenant;
    expect(rel).toEqual({ select: { suspended_at: true } });
  });

  it('sem nome/token nem consulta o banco', async () => {
    const { service, prisma } = makeInbound(instanceRow(null));
    await expect(service.findInstanceByName(undefined)).resolves.toBeNull();
    await expect(service.findInstanceByUazapiToken(undefined)).resolves.toBeNull();
    await expect(service.findEvolutionInstanceByName(undefined)).resolves.toBeNull();
    expect(prisma.whatsappInstance.findFirst).not.toHaveBeenCalled();
  });
});

// ── MessagesSendProcessor ────────────────────────────────────────────────────

function makeProcessor(suspendedAt: Date | null) {
  const prisma: any = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ suspended_at: suspendedAt }) },
    message: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    lead: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  // firstValueFrom precisa de um Observable de verdade — daí o `of` do rxjs.
  const http: any = { post: jest.fn().mockReturnValue(of({ data: { id: 'wa-1' } })) };
  const media: any = { getSignedUrl: jest.fn() };
  const gateway: any = { emitMessageStatusUpdate: jest.fn() };
  const cache: any = { delPattern: jest.fn().mockResolvedValue(undefined) };
  const processor = new MessagesSendProcessor(http, prisma, media, gateway, cache);
  return { processor, prisma, http, gateway };
}

const textJob = {
  data: {
    kind: 'text',
    messageId: 'm1',
    leadId: 'l1',
    tenantId: 't1',
    instanceName: 'x',
    telefone: '5511900000000',
    provider: 'uazapi',
    uazBaseUrl: 'https://uaz.example',
    uazToken: 'tok',
    content: 'oi',
  } satisfies SendTextJobData,
} as Job<SendTextJobData>;

describe('envio de tenant suspenso', () => {
  it('descarta o job sem chamar o gateway de WhatsApp', async () => {
    const { processor, http, prisma } = makeProcessor(new Date());
    await processor.process(textJob);
    expect(http.post).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('tenant ativo segue enviando normalmente', async () => {
    const { processor, http, prisma } = makeProcessor(null);
    await processor.process(textJob);
    expect(http.post).toHaveBeenCalled();
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SENT', whatsapp_message_id: 'wa-1' } }),
    );
  });
});

// ── PlatformAdminService.setTenantSuspended ──────────────────────────────────

const admin = { id: 'adm', email: 'a@a', tenantId: 't-adm', role: 'SUPER_ADMIN' } as unknown as AuthUser;

function makeAdminSvc() {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ platform_scopes: ['*'] }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }),
      update: jest.fn().mockResolvedValue({}),
    },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('setTenantSuspended grava suspended_at', () => {
  it('suspender carimba a data', async () => {
    const { svc, prisma } = makeAdminSvc();
    await svc.setTenantSuspended(admin, 't1', true);
    const arg = prisma.tenant.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 't1' });
    expect(arg.data.suspended_at).toBeInstanceOf(Date);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ativo: false } }),
    );
  });

  it('reativar limpa a data', async () => {
    const { svc, prisma } = makeAdminSvc();
    await svc.setTenantSuspended(admin, 't1', false);
    const arg = prisma.tenant.update.mock.calls[0][0];
    expect(arg.data.suspended_at).toBeNull();
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ativo: true } }),
    );
  });
});
