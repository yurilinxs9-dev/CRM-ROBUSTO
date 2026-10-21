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
  const conversations: any = {
    resolveForInbound: jest.fn().mockResolvedValue({ id: 'conv-routing-test', responsavel_id: null }),
  };
  return {
    prisma, http, config, media, audio, gateway, cache, mediaPipeline,
    sendQueue, outboundWebhooks, push, conversations,
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
    m.conversations,
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

describe('perfil restrito PL', () => {
  const seller: AuthUser = { ...alex, tenantId: 'a44772ed-1382-4400-84fc-3fa350e23e42', plSalesOnly: true };
  it('conversa antiga não permite enviar para lead transferido', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'outra' });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'antiga', instancia_whatsapp: 'inst-A' });
    await expect(service.sendText({ lead_id: LEAD_ID, content: 'oi' }, seller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendQueue.add).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });
  it.each(['getHistory', 'syncChat'] as const)('%s rejeita lead transferido antes de consultar histórico', async (method) => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...baseLead, responsavel_id: 'outra' });
    await expect(service[method](LEAD_ID, seller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.whatsappInstance.findFirst).not.toHaveBeenCalled();
  });
  it('não disponibiliza arquivo de outro lead', async () => {
    const { service, prisma } = makeService();
    prisma.message.findFirst = jest.fn().mockResolvedValue({ lead_id: LEAD_ID, media_url: 'arquivo' });
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(service.streamMedia('msg-1', seller)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

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

it('Consórcio PL usa o WhatsApp de origem após distribuição manual, mesmo sem número próprio', async () => {
  const m=makeService();
  const tenant='a44772ed-1382-4400-84fc-3fa350e23e42';
  m.prisma.lead.findFirst.mockResolvedValue({...baseLead,tenant_id:tenant,pipeline_id:'6f749216-8d83-44ed-8fd0-1c57720c9f11',responsavel_id:alex.id});
  m.prisma.whatsappInstance.findFirst.mockResolvedValue(liveInstance('inst-A','gestora'));
  await m.service.sendText({lead_id:LEAD_ID,content:'Olá'}, {...alex,tenantId:tenant});
  expect(m.sendQueue.add).toHaveBeenCalledWith('send-text',expect.objectContaining({instanceName:'inst-A'}));
});

it('Consórcio PL rejeita reenvio automático por outro número quando origem está offline', async()=>{
 const m=makeService();const tenant='a44772ed-1382-4400-84fc-3fa350e23e42';
 m.prisma.message.findUnique=jest.fn().mockResolvedValue({id:'m',lead_id:LEAD_ID,tenant_id:tenant,direction:'OUTGOING',status:'FAILED',instance_name:'origin',type:'TEXT'});
 m.prisma.lead.findFirst.mockResolvedValue({...baseLead,pipeline_id:'6f749216-8d83-44ed-8fd0-1c57720c9f11',instancia_whatsapp:'origin'});
 m.prisma.whatsappInstance.findFirst.mockResolvedValueOnce({...liveInstance('origin'),status:'disconnected'}).mockResolvedValue(liveInstance('other'));
 await expect(m.service.resend('m')).rejects.toThrow('Nenhuma instancia');
 expect(m.prisma.whatsappInstance.findFirst).toHaveBeenCalledTimes(1);
 expect(m.sendQueue.add).not.toHaveBeenCalled();
});

it('Consórcio PL não importa histórico genérico do telefone ao abrir chat', async()=>{
 const m=makeService();const tenant='a44772ed-1382-4400-84fc-3fa350e23e42';
 m.prisma.lead.findFirst.mockResolvedValue({...baseLead,pipeline_id:'6f749216-8d83-44ed-8fd0-1c57720c9f11'});
 m.prisma.whatsappInstance.findFirst.mockResolvedValue(liveInstance('origin'));
 m.prisma.message.findMany=jest.fn().mockResolvedValue([]);
 const remote=jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({messages:[{messageid:'partner-message',content:'Histórico de parceria',messageType:'Conversation'}]})} as Response);
 try {expect(await m.service.syncChat(LEAD_ID,{...alex,tenantId:tenant})).toEqual({added:0,mediaFixed:0});expect(m.prisma.message.create).not.toHaveBeenCalled();}
 finally {remote.mockRestore();}
});

describe('MessagesService.sendText — acesso total do gestor (Individual)', () => {
  const dono: AuthUser = {
    ...alex,
    id: 'u-dono',
    nome: 'Dono',
    email: 'dono@x.com',
    role: UserRole.SUPER_ADMIN as unknown as AuthUser['role'],
  };
  // Fábrica: o service reescreve `lead.instancia_whatsapp` em memória no objeto devolvido.
  const leadDoVendedor = () => ({ ...baseLead, responsavel_id: 'u-vendedor', instancia_whatsapp: 'inst-vendedor' });
  const instancias = ({ where }: any) => {
    if (where.nome === 'inst-vendedor') return Promise.resolve(liveInstance('inst-vendedor', 'u-vendedor'));
    if (where.owner_user_id === 'u-dono') return Promise.resolve(liveInstance('inst-dono', 'u-dono'));
    return Promise.resolve(null);
  };

  it('responde pelo número do vendedor, não pelo do dono', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue(leadDoVendedor());
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false, manager_full_access: true });
    prisma.whatsappInstance.findFirst.mockImplementation(instancias);

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, dono);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-vendedor' }),
    );
  });

  it('sem a flag mantém o comportamento antigo (troca pro número do gestor)', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue(leadDoVendedor());
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false, manager_full_access: false });
    prisma.whatsappInstance.findFirst.mockImplementation(instancias);

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, dono);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-dono' }),
    );
  });

  it('com a flag, responde em lead privado de outro', async () => {
    const { service, prisma, sendQueue } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...leadDoVendedor(), is_private: true });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false, manager_full_access: true });
    prisma.whatsappInstance.findFirst.mockImplementation(instancias);

    await service.sendText({ lead_id: LEAD_ID, content: 'oi' }, dono);

    expect(sendQueue.add).toHaveBeenCalledWith(
      'send-text',
      expect.objectContaining({ instanceName: 'inst-vendedor' }),
    );
  });

  it('sem a flag, lead privado de outro segue bloqueado', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...leadDoVendedor(), is_private: true });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false, manager_full_access: false });

    await expect(
      service.sendText({ lead_id: LEAD_ID, content: 'oi' }, dono),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('em modo foco a flag não vale', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({ ...leadDoVendedor(), is_private: true });
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false, manager_full_access: true });
    prisma.user.findUnique.mockResolvedValue({ focus_mode: true });

    await expect(
      service.sendText({ lead_id: LEAD_ID, content: 'oi' }, dono),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
