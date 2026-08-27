import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import type { Logger } from '@nestjs/common';
import { InstanceHealthService } from './instance-health.service';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PushService } from '../push/push.service';

const UAZ_BASE = 'https://uazapi.test';
const EVO_BASE = 'http://evolution:8080';

const ENV: Record<string, string> = {
  UAZAPI_BASE_URL: UAZ_BASE,
  EVOLUTION_BASE_URL: EVO_BASE,
};

interface InstanceRow {
  id: string;
  nome: string;
  status: string;
  telefone: string | null;
  tenant_id: string;
  config: Record<string, unknown> | null;
  tenant: { nome: string; suspended_at: Date | null };
}

function uaz(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'inst-uaz',
    nome: 'atendimento-alex',
    status: 'open',
    telefone: '5511988887777',
    tenant_id: 'tenant-1',
    config: { uazapi_token: 'tok-1' },
    tenant: { nome: 'Cajuru', suspended_at: null },
    ...over,
  };
}

function evo(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'inst-evo',
    nome: 'vendas-evo',
    status: 'open',
    telefone: '5511977776666',
    tenant_id: 'tenant-2',
    config: { provider: 'evolution', evolution_token: 'evo-key-1' },
    tenant: { nome: 'Porto Sul', suspended_at: null },
    ...over,
  };
}

// ── Respostas dos gateways ───────────────────────────────────────────────────

const uazStatusConectado = {
  data: {
    instance: { status: 'connected' },
    status: { connected: true, loggedIn: true, jid: '5511999@s.whatsapp.net' },
  },
};
const uazStatusConnecting = {
  data: {
    instance: { status: 'connecting', qrcode: 'data:image/png;base64,QR' },
    status: { connected: false, loggedIn: false, jid: null },
  },
};
const uazStatusCaido = {
  data: {
    instance: { status: 'disconnected' },
    status: { connected: false, loggedIn: false, jid: null },
  },
};
const uazConnectConectado = {
  data: {
    instance: { status: 'connected' },
    status: { connected: true, loggedIn: true, jid: null },
  },
};
const uazConnectComQr = {
  data: {
    instance: { status: 'connecting', qrcode: 'data:image/png;base64,AAA' },
    status: { connected: false, loggedIn: false, jid: null },
  },
};
const evoState = (state: string) => ({ data: { instance: { state } } });
const evoConnectComQr = { data: { base64: 'data:image/png;base64,AAA', code: '2@abc' } };

const ADMINS = [
  { id: 'admin-1', tenant_id: 'tenant-master' },
  { id: 'admin-2', tenant_id: 'tenant-master' },
];

function build(instances: InstanceRow[]) {
  const httpGet = jest.fn();
  const httpPost = jest.fn();
  const http = { get: httpGet, post: httpPost } as unknown as HttpService;
  const config = {
    get: (key: string, def?: string) => ENV[key] ?? def,
  } as unknown as ConfigService;
  const prisma = {
    whatsappInstance: {
      findMany: jest.fn().mockResolvedValue(instances),
      findFirst: jest.fn().mockResolvedValue(instances[0] ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    instanceAlert: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'alert-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findMany: jest.fn().mockResolvedValue(ADMINS) },
    notification: { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) },
  };
  const push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
  const service = new InstanceHealthService(
    prisma as unknown as PrismaService,
    http,
    config,
    push as unknown as PushService,
  );
  return { service, prisma, push, httpGet, httpPost };
}

describe('InstanceHealthService.verificarTodas', () => {
  // (a)
  it('UazAPI conectada: marca open + ultimo_check, sem reconexão nem alerta', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));

    await m.service.verificarTodas();

    expect(m.httpGet).toHaveBeenCalledWith(
      `${UAZ_BASE}/instance/status`,
      expect.objectContaining({
        headers: expect.objectContaining({ token: 'tok-1' }),
        timeout: 5000,
      }),
    );
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });
    expect(m.httpPost).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
  });

  // (b)
  it('caída no 1º ciclo: tenta connect e, reconectando, fica open sem alerta', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectConectado));

    await m.service.verificarTodas();

    expect(m.httpPost).toHaveBeenCalledWith(
      `${UAZ_BASE}/instance/connect`,
      {},
      expect.objectContaining({
        headers: expect.objectContaining({ token: 'tok-1' }),
        timeout: 5000,
      }),
    );
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.prisma.notification.create).not.toHaveBeenCalled();
  });

  // (c)
  it('connect devolve QR: 1º ciclo não alerta, 2º alerta uma vez, 3º não duplica', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    // 1º ciclo: continua caída, mas ainda sem alerta (anti-flap).
    await m.service.verificarTodas();
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'close', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();

    // 2º ciclo consecutivo: abre alerta + notifica todo platform admin.
    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: 'tenant-1',
        instance_id: 'inst-uaz',
        tipo: 'desconectada',
        aberto_em: expect.any(Date),
      }),
    });

    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    const textoEsperado = expect.stringMatching(
      /^Instância atendimento-alex \(Cajuru\) desconectada desde \d{2}:\d{2} — provavelmente precisa de QR novo\.$/,
    );
    expect(m.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'admin-1',
        tenant_id: 'tenant-master',
        titulo: 'Instância desconectada',
        conteudo: textoEsperado,
        link: '/admin',
      }),
    });
    expect(m.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ user_id: 'admin-2' }),
    });

    expect(m.push.sendToUsers).toHaveBeenCalledTimes(1);
    expect(m.push.sendToUsers).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      expect.objectContaining({
        title: 'Instância desconectada',
        body: textoEsperado,
        url: '/admin',
      }),
    );

    // 3º ciclo: alerta já aberto no banco → não duplica nada.
    m.prisma.instanceAlert.findFirst.mockResolvedValue({
      id: 'alert-1',
      instance_id: 'inst-uaz',
      resolvido_em: null,
    });
    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(m.push.sendToUsers).toHaveBeenCalledTimes(1);
  });

  // (d)
  it('recuperou no cron com alerta aberto: resolve e avisa a recuperação', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.instanceAlert.findFirst.mockResolvedValue({
      id: 'alert-1',
      instance_id: 'inst-uaz',
      resolvido_em: null,
    });

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: { resolvido_em: expect.any(Date) },
    });
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'admin-1',
        conteudo: 'Instância atendimento-alex (Cajuru) reconectou.',
        link: '/admin',
      }),
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
  });

  // (f)
  it('pula tenant suspenso e instância sem token conhecido (gateway nem é chamado)', async () => {
    const m = build([
      uaz({ id: 'inst-susp', tenant: { nome: 'Suspenso', suspended_at: new Date() } }),
      uaz({ id: 'inst-legado', config: { provider: 'wppconnect' } }),
      uaz({ id: 'inst-sem-config', config: null }),
    ]);

    const r = await m.service.verificarTodas();

    expect(m.httpGet).not.toHaveBeenCalled();
    expect(m.httpPost).not.toHaveBeenCalled();
    expect(m.prisma.whatsappInstance.update).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(r.verificadas).toBe(0);
  });

  // (g)
  it('erro de rede no status: não toca no banco, não alerta e segue pra próxima', async () => {
    const m = build([uaz(), evo()]);
    const err = new AxiosError('socket hang up');
    m.httpGet.mockImplementation((url: string) =>
      url.includes('uazapi') ? throwError(() => err) : of(evoState('open')),
    );

    await m.service.verificarTodas();

    // A caída de rede não vira status no banco…
    expect(m.prisma.whatsappInstance.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inst-uaz' } }),
    );
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    // …e o loop continua: a instância seguinte foi checada e atualizada.
    expect(m.httpGet).toHaveBeenCalledWith(
      `${EVO_BASE}/instance/connectionState/vendas-evo`,
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });
  });

  // (g2) rede instável nunca conta ciclo caída: 2 erros seguidos não alertam
  it('dois ciclos de erro de rede seguidos não abrem alerta', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(throwError(() => new AxiosError('ETIMEDOUT')));

    await m.service.verificarTodas();
    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
  });

  // (h)
  it('Evolution: state close tenta connect com apikey da instância', async () => {
    const m = build([evo({ status: 'open' })]);
    m.httpGet.mockImplementation((url: string) =>
      url.includes('connectionState') ? of(evoState('close')) : of(evoConnectComQr),
    );

    await m.service.verificarTodas();

    expect(m.httpGet).toHaveBeenCalledWith(
      `${EVO_BASE}/instance/connect/vendas-evo`,
      expect.objectContaining({
        headers: expect.objectContaining({ apikey: 'evo-key-1' }),
        timeout: 5000,
      }),
    );
    // QR na resposta = NÃO reconectou → segue caída no banco.
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: 'close', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
  });

  // (h) mapeamento de state
  it.each([
    ['open', 'open'],
    ['connecting', 'connecting'],
    ['close', 'close'],
  ])('Evolution: state %s vira status %s no banco', async (state, esperado) => {
    const m = build([evo()]);
    m.httpGet.mockImplementation((url: string) =>
      url.includes('connectionState') ? of(evoState(state)) : of(evoConnectComQr),
    );

    await m.service.verificarTodas();

    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: esperado, ultimo_check: expect.any(Date) },
    });
  });

  // (i) NÃO sabotar o pareamento em andamento
  it('instância nova em connecting (nunca pareada): não chama connect nem alerta', async () => {
    const m = build([uaz({ status: 'connecting', telefone: null })]);
    m.httpGet.mockReturnValue(of(uazStatusConnecting));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();
    await m.service.verificarTodas();
    await m.service.verificarTodas();

    // POST /instance/connect re-emitiria o QR e invalidaria o que a pessoa
    // está lendo agora no dialog.
    expect(m.httpPost).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'connecting', ultimo_check: expect.any(Date) },
    });
  });

  // (ii) pareada e presa em connecting É queda
  it('instância pareada presa em connecting: reconecta e alerta no 2º ciclo', async () => {
    const m = build([uaz({ status: 'connecting', telefone: '5511988887777' })]);
    m.httpGet.mockReturnValue(of(uazStatusConnecting));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();
    expect(m.httpPost).toHaveBeenCalledWith(
      `${UAZ_BASE}/instance/connect`,
      {},
      expect.anything(),
    );
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();

    await m.service.verificarTodas();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  it('instância nunca pareada mas já vista open no banco conta como pareada', async () => {
    const m = build([uaz({ status: 'open', telefone: null })]);
    m.httpGet.mockReturnValue(of(uazStatusConnecting));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();

    expect(m.httpPost).toHaveBeenCalled();
  });

  // Evolution: state manda mais que a ausência de QR
  it('Evolution: connect devolve state connecting sem QR → NÃO reconectou', async () => {
    const m = build([evo({ status: 'close' })]);
    m.httpGet.mockImplementation((url: string) =>
      url.includes('connectionState')
        ? of(evoState('close'))
        : of({ data: { instance: { state: 'connecting' } } }),
    );

    await m.service.verificarTodas();

    // Sem isso a instância virava "open" no banco, o alerta era resolvido e
    // dois ciclos depois abria outro: notificação nova a cada ~15 min.
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: 'close', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.whatsappInstance.update).not.toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });

    await m.service.verificarTodas();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  it('Evolution: connect devolve state open → reconectou', async () => {
    const m = build([evo({ status: 'close' })]);
    m.httpGet.mockImplementation((url: string) =>
      url.includes('connectionState')
        ? of(evoState('close'))
        : of({ data: { instance: { state: 'open' } } }),
    );

    await m.service.verificarTodas();

    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-evo' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
  });

  // Gateway cego não pode ser invisível no log de produção
  it('3 ciclos seguidos sem resposta do gateway: um warn, e não repete no 4º', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(throwError(() => new AxiosError('ETIMEDOUT')));
    const warn = jest
      .spyOn((m.service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);

    await m.service.verificarTodas();
    await m.service.verificarTodas();
    expect(warn).not.toHaveBeenCalled();

    await m.service.verificarTodas();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('sem resposta do gateway');

    await m.service.verificarTodas();
    expect(warn).toHaveBeenCalledTimes(1); // throttle de 10min
  });

  it('gateway volta a responder: contador de cegueira zera', async () => {
    const m = build([uaz()]);
    const warn = jest
      .spyOn((m.service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
    m.httpGet.mockReturnValue(throwError(() => new AxiosError('ETIMEDOUT')));

    await m.service.verificarTodas();
    await m.service.verificarTodas();
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    await m.service.verificarTodas();
    m.httpGet.mockReturnValue(throwError(() => new AxiosError('ETIMEDOUT')));
    await m.service.verificarTodas();
    await m.service.verificarTodas();

    expect(warn).not.toHaveBeenCalled();
  });

  it('usa evolution_base_url da instância quando presente', async () => {
    const m = build([
      evo({ config: { provider: 'evolution', evolution_token: 'k', evolution_base_url: 'http://evo2:8080' } }),
    ]);
    m.httpGet.mockReturnValue(of(evoState('open')));

    await m.service.verificarTodas();

    expect(m.httpGet).toHaveBeenCalledWith(
      'http://evo2:8080/instance/connectionState/vendas-evo',
      expect.anything(),
    );
  });
});

describe('InstanceHealthService.resolverAlerta', () => {
  // (e)
  it('resolve o alerta aberto e notifica a recuperação', async () => {
    const m = build([uaz()]);
    m.prisma.instanceAlert.findFirst.mockResolvedValue({
      id: 'alert-9',
      instance_id: 'inst-uaz',
      resolvido_em: null,
    });

    await m.service.resolverAlerta('inst-uaz');

    expect(m.prisma.instanceAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-9' },
      data: { resolvido_em: expect.any(Date) },
    });
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        titulo: 'Instância reconectada',
        conteudo: 'Instância atendimento-alex (Cajuru) reconectou.',
        link: '/admin',
      }),
    });
    expect(m.push.sendToUsers).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      expect.objectContaining({ body: 'Instância atendimento-alex (Cajuru) reconectou.' }),
    );
  });

  it('sem alerta aberto não escreve nem notifica nada', async () => {
    const m = build([uaz()]);

    await m.service.resolverAlerta('inst-uaz');

    expect(m.prisma.instanceAlert.update).not.toHaveBeenCalled();
    expect(m.prisma.notification.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
  });

  it('zera o contador anti-flap: depois de resolver, precisa de 2 ciclos de novo', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas(); // ciclo 1 caída

    m.prisma.instanceAlert.findFirst.mockResolvedValue({
      id: 'alert-9',
      instance_id: 'inst-uaz',
      resolvido_em: null,
    });
    await m.service.resolverAlerta('inst-uaz'); // webhook: voltou
    m.prisma.instanceAlert.findFirst.mockResolvedValue(null);

    await m.service.verificarTodas(); // caiu de novo: 1º ciclo, ainda sem alerta

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
  });
});
