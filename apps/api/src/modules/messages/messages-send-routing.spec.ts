import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task 6 — o envio resolvia a instância por `lead.instancia_whatsapp`, que
 * agora é um espelho da conversa ATIVA (Task 4) e pode apontar pro número de
 * OUTRO vendedor (o que motivou este fix inteiro: mensagem nova roteada pro
 * primeiro atendente, não pro atual). A partir de agora a instância de envio
 * vem da conversa PRÓPRIA do atendente (`Conversation.responsavel_id = user.id`)
 * com aquele lead; `lead.instancia_whatsapp` só entra como fallback quando o
 * atendente não tem conversa própria alguma.
 *
 * Estes specs mockam o Prisma e exercitam `sendText()` de verdade (não uma
 * função pura auxiliar) — a mesma armadilha do spec de claim/reassign (Task 9):
 * um teste que só chamasse a lógica de resolução em isolamento passaria igual
 * com a versão antiga.
 */

function makeMocks() {
  const prisma: any = {
    lead: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: false }),
      findUnique: jest.fn().mockResolvedValue({ pool_enabled: false, prefix_enabled: false }),
    },
    whatsappInstance: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    message: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'msg-1', ...data }),
      ),
    },
  };
  const http: any = {};
  const config: any = { get: jest.fn().mockReturnValue('') };
  const media: any = {};
  const audio: any = {};
  const gateway: any = { emitNewMessage: jest.fn() };
  const cache: any = {};
  const mediaPipeline: any = {};
  const sendQueue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const outboundWebhooks: any = { dispatchMessageCreated: jest.fn().mockResolvedValue(undefined) };
  const push: any = {};
  return {
    prisma, http, config, media, audio, gateway, cache, mediaPipeline,
    sendQueue, outboundWebhooks, push,
  };
}

function makeService() {
  const m = makeMocks();
  const service = new MessagesService(
    m.http,
    m.config,
    m.prisma,
    m.media,
    m.audio,
    m.gateway,
    m.cache,
    m.mediaPipeline,
    m.sendQueue,
    m.outboundWebhooks,
    m.push,
  );
  return { service, ...m };
}

const LEAD_ID = '369354c4-b4d6-4bb1-93c0-0afeedc1450e';

const baseLead = {
  id: LEAD_ID,
  tenant_id: 't1',
  telefone: '5511999990000',
  is_private: false,
  proximo_followup: null,
  cadence_step_index: 0,
  responsavel_id: null as string | null,
  instancia_whatsapp: 'inst-A', // espelho da conversa ATIVA — não é a do atendente
};

const liveInstance = (nome: string, ownerId: string | null = null) => ({
  id: `wa-${nome}`,
  nome,
  status: 'connected',
  owner_user_id: ownerId,
  config: { uazapi_token: 'tok' },
});

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('MessagesService.sendText — instância sai da conversa do atendente, não do Lead', () => {
  it('DISCRIMINANTE: lead.instancia_whatsapp aponta pra A (outro vendedor); Alex tem conversa própria em B — envia por B', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true }); // Compartilhado
    // A MESMA conversa de Alex responde tanto ao gate de acesso (findFirst com
    // select {id}) quanto à resolução de instância (select {instancia_whatsapp}).
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-alex', instancia_whatsapp: 'inst-B' });
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where.nome === 'inst-B') return Promise.resolve(liveInstance('inst-B'));
      if (where.nome === 'inst-A') return Promise.resolve(liveInstance('inst-A'));
      return Promise.resolve(null);
    });

    const result = await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-B' }),
    );
    expect((result as any).instance_name).toBe('inst-B');
  });

  it('sem conversa própria, cai pro instancia_whatsapp do lead (comportamento antigo como fallback)', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'u-alex' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });
    prisma.conversation.findFirst.mockResolvedValue(null); // Alex não tem conversa própria ainda
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where.nome === 'inst-A') return Promise.resolve(liveInstance('inst-A'));
      return Promise.resolve(null);
    });

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-A' }),
    );
  });

  it('operador sem ser responsável e sem conversa própria: acesso negado', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'outro-user' });
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('operador com conversa própria (mas não responsável do card) tem acesso', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'outro-user' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-alex', instancia_whatsapp: 'inst-B' });
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) =>
      where.nome === 'inst-B' ? Promise.resolve(liveInstance('inst-B')) : Promise.resolve(null),
    );

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-B' }),
    );
  });
});

describe('MessagesService.sendText — auto-swap continua funcionando (rede de segurança)', () => {
  it('Compartilhado: instância preferida ausente/desconectada cai pra qualquer instância viva do tenant', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'u-alex', instancia_whatsapp: 'inst-morta' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where.nome === 'inst-morta') return Promise.resolve(null); // instância removida
      if (where.status) return Promise.resolve(liveInstance('inst-qualquer')); // fallback do tenant
      return Promise.resolve(null);
    });

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-qualquer' }),
    );
    // Task 6, Step 3: nada mais escreve instancia_whatsapp no Lead — quem faz
    // isso é ConversationService.syncLeadFromActive.
    for (const call of prisma.lead.update.mock.calls) {
      expect(call[0]?.data?.instancia_whatsapp).toBeUndefined();
    }
  });

  it('Individual: instância do lead morta/de outro dono cai pra instância viva do próprio Alex', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'u-alex', instancia_whatsapp: 'inst-outro-dono' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false }); // Individual
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.whatsappInstance.findFirst.mockImplementation(({ where }: any) => {
      if (where.nome === 'inst-outro-dono') {
        return Promise.resolve(liveInstance('inst-outro-dono', 'outro-user')); // não é do Alex
      }
      if (where.owner_user_id === 'u-alex') return Promise.resolve(liveInstance('inst-alex-propria', 'u-alex'));
      return Promise.resolve(null);
    });

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-alex-propria' }),
    );
    for (const call of prisma.lead.update.mock.calls) {
      expect(call[0]?.data?.instancia_whatsapp).toBeUndefined();
    }
  });

  it('Individual: sem instância própria viva, nenhuma disponível — Forbidden (não trava o app)', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'u-alex', instancia_whatsapp: 'inst-outro-dono' });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);

    await expect(
      service.sendText({ lead_id: LEAD_ID, content: 'oi' }, alex),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
