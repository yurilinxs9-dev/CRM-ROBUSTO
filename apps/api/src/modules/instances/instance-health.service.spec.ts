import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import type { Logger } from '@nestjs/common';
import { InstanceHealthService } from './instance-health.service';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { HistorySyncService } from '../webhooks/history-sync.service';

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
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { findMany: jest.fn().mockResolvedValue(ADMINS) },
    notification: { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) },
    // Sinal de "já teve sessão" das instâncias sem telefone (Evolution).
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
    // Detector de silêncio de inbound: por padrão chegou mensagem de cliente
    // agora há pouco (instância saudável) — os testes de silêncio sobrescrevem.
    message: {
      findFirst: jest.fn().mockResolvedValue({ created_at: new Date() }),
      count: jest.fn().mockResolvedValue(0),
    },
    webhookLog: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
  const historySync = {
    syncInstance: jest.fn().mockResolvedValue(undefined),
    syncEvolutionInstance: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InstanceHealthService(
    prisma as unknown as PrismaService,
    http,
    config,
    push as unknown as PushService,
    historySync as unknown as HistorySyncService,
  );
  return { service, prisma, push, historySync, httpGet, httpPost };
}

/** Silêncio de inbound: última mensagem de cliente mais velha que a janela. */
function horasAtras(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

interface WebhookLogRow {
  id: string;
  event: string;
  instance: string;
  tenant_id: string | null;
}

interface WebhookLogArgs {
  where: {
    event?: { in?: string[] };
    instance?: { in?: string[] };
    OR?: Array<{ tenant_id: string | null }>;
  };
}

/**
 * WebhookLog de mentira que HONRA os filtros: filtro ausente casa com tudo,
 * como no banco. É o que faz o teste enxergar a diferença entre "qualquer
 * webhook" e "webhook de mensagem deste tenant".
 */
function fakeWebhookLogs(m: ReturnType<typeof build>, rows: WebhookLogRow[]): void {
  m.prisma.webhookLog.findFirst.mockImplementation((args: WebhookLogArgs) => {
    const w = args.where;
    const achou = rows.find(
      (r) =>
        (w.event?.in === undefined || w.event.in.includes(r.event)) &&
        (w.instance?.in === undefined || w.instance.in.includes(r.instance)) &&
        (w.OR === undefined || w.OR.some((c) => c.tenant_id === r.tenant_id)),
    );
    return Promise.resolve(achou ?? null);
  });
}

/** Instância conectada, movimentada e sem inbound há horas. */
function comSilencio(m: ReturnType<typeof build>, horas = 10): void {
  m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(horas) });
  m.prisma.message.count.mockResolvedValue(42);
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

  // Nunca pareada + close: QR criado e abandonado não é queda
  it('instância nunca pareada com gateway close: nenhum connect, nenhum alerta', async () => {
    const m = build([uaz({ status: 'close', telefone: null })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();
    await m.service.verificarTodas();
    await m.service.verificarTodas();

    expect(m.httpPost).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.push.sendToUsers).not.toHaveBeenCalled();
    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'close', ultimo_check: expect.any(Date) },
    });
  });

  // Evolution caída NUNCA ganha `telefone` (só os caminhos UazAPI preenchem) e
  // o webhook já reescreveu o status pra 'close': sem o sinal do lead, o gate
  // de nunca-pareada cegaria justamente o caso que o monitor existe pra pegar.
  it('sem telefone e sem status open, mas com lead pelo número: é queda de verdade', async () => {
    const m = build([evo({ status: 'close', telefone: null })]);
    m.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
    m.httpGet.mockImplementation((url: string) =>
      url.includes('connectionState') ? of(evoState('close')) : of(evoConnectComQr),
    );

    await m.service.verificarTodas();
    await m.service.verificarTodas();

    expect(m.prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenant_id: 'tenant-2', instancia_whatsapp: 'vendas-evo' },
      }),
    );
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  it('instância pareada (com telefone) e close: fluxo normal de caída', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();
    await m.service.verificarTodas();

    expect(m.prisma.lead.findFirst).not.toHaveBeenCalled(); // telefone já basta
    expect(m.httpPost).toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
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

  // UazAPI: status manda mais que a ausência de qrcode (espelho do Evolution)
  it('UazAPI: connect devolve status connecting sem qrcode → NÃO reconectou', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(
      of({
        data: {
          instance: { status: 'connecting' },
          status: { connected: false, loggedIn: false, jid: null },
        },
      }),
    );

    await m.service.verificarTodas();

    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'close', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.whatsappInstance.update).not.toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });

    // …e a queda segue contando: 2º ciclo abre o alerta normalmente.
    await m.service.verificarTodas();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  it('UazAPI: connect devolve status connected → reconectou', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectConectado));

    await m.service.verificarTodas();

    expect(m.prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-uaz' },
      data: { status: 'open', ultimo_check: expect.any(Date) },
    });
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
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

// Incidente 28→31/08/2026: o servidor UazAPI parou de entregar webhook de
// mensagem de CLIENTE em todas as instâncias. Status ficou 'open' o tempo
// todo, o monitor não viu nada e clientes ficaram 3 dias sem resposta.
describe('InstanceHealthService: detector de silêncio de inbound', () => {
  interface AlertWhere {
    where: { tipo?: string };
  }

  it('conectada, sem inbound há horas mas com webhook vivo: alerta e dispara o sync', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(10) });
    m.prisma.message.count.mockResolvedValue(42); // baseline: instância movimentada
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-1' }); // canal vivo

    const r = await m.service.verificarTodas();

    expect(m.prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant_id: 'tenant-1',
          instance_name: 'atendimento-alex',
          direction: 'INCOMING',
        }),
      }),
    );
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: 'tenant-1',
        instance_id: 'inst-uaz',
        tipo: 'inbound_silencioso',
        aberto_em: expect.any(Date),
      }),
    });

    const texto = expect.stringMatching(
      /^Instância atendimento-alex \(Cajuru\) conectada mas sem mensagens de clientes há 10h — possível falha de entrega do provedor; sincronização de histórico disparada\.$/,
    );
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'admin-1',
        titulo: 'Instância sem mensagens recebidas',
        conteudo: texto,
        tipo: 'instance_alert',
        link: '/admin',
      }),
    });
    expect(m.push.sendToUsers).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      expect.objectContaining({ body: texto }),
    );

    expect(m.historySync.syncInstance).toHaveBeenCalledWith(
      'inst-uaz',
      HistorySyncService.RECONNECT_WINDOW_MS,
    );
    expect(r.silencios).toBe(1);
  });

  it('silêncio total (nenhum webhook na janela): não é este alerta', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(10) });
    m.prisma.message.count.mockResolvedValue(42);
    m.prisma.webhookLog.findFirst.mockResolvedValue(null);

    const r = await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.prisma.notification.create).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
    expect(r.silencios).toBe(0);
  });

  it('instância sem volume histórico: silêncio não vira alerta', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(30) });
    m.prisma.message.count.mockResolvedValue(3); // < mínimo de 10 nos 7d
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-1' });

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
  });

  it('cooldown: alerta de silêncio recente não re-alerta nem re-sincroniza', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(10) });
    m.prisma.message.count.mockResolvedValue(42);
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-1' });
    m.prisma.instanceAlert.findFirst.mockImplementation((args: AlertWhere) =>
      Promise.resolve(
        args.where.tipo === 'inbound_silencioso'
          ? { id: 'alert-sil', aberto_em: horasAtras(2) }
          : null,
      ),
    );

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          instance_id: 'inst-uaz',
          tipo: 'inbound_silencioso',
          aberto_em: { gte: expect.any(Date) },
        }),
      }),
    );
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.prisma.notification.create).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
  });

  it('inbound recente: nem consulta o resto', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(1) });

    await m.service.verificarTodas();

    expect(m.prisma.webhookLog.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.message.count).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
  });

  it('instância caída não passa pelo detector (é a queda de sempre)', async () => {
    const m = build([uaz({ status: 'close' })]);
    m.httpGet.mockReturnValue(of(uazStatusCaido));
    m.httpPost.mockReturnValue(of(uazConnectComQr));

    await m.service.verificarTodas();

    expect(m.prisma.message.findFirst).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
  });

  // O cooldown já foi gravado quando o aviso roda: se o aviso derruba o
  // caminho, o sync nunca acontece e a instância fica cega por 6h.
  it('aviso ao admin falhando não impede o sync', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-1' });
    m.prisma.notification.create.mockRejectedValue(new Error('banco fora'));

    const r = await m.service.verificarTodas();

    expect(m.historySync.syncInstance).toHaveBeenCalledWith(
      'inst-uaz',
      HistorySyncService.RECONNECT_WINDOW_MS,
    );
    expect(r.silencios).toBe(1);
  });

  // Falso positivo noturno: loja fechada, ninguém escreve, mas presence/status
  // continuam pingando. Só evento de MENSAGEM prova que o inbound funcionaria.
  it('presence/connection não contam como canal vivo', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    fakeWebhookLogs(m, [
      { id: 'wl-p', event: 'uazapi.presence', instance: 'atendimento-alex', tenant_id: 'tenant-1' },
      {
        id: 'wl-c',
        event: 'uazapi.connection_update',
        instance: 'atendimento-alex',
        tenant_id: 'tenant-1',
      },
    ]);

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
  });

  it('mensagem na janela (mesmo só fromMe) é canal vivo: alerta', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    fakeWebhookLogs(m, [
      { id: 'wl-m', event: 'uazapi.messages', instance: 'atendimento-alex', tenant_id: 'tenant-1' },
    ]);

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  // Nome de instância só é único POR tenant (bug já conhecido no repo).
  it('webhook de instância homônima de outro tenant não prova canal vivo', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    fakeWebhookLogs(m, [
      { id: 'wl-x', event: 'uazapi.messages', instance: 'atendimento-alex', tenant_id: 'tenant-9' },
    ]);

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).not.toHaveBeenCalled();
  });

  it('log legado sem tenant_id ainda conta como canal vivo', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    fakeWebhookLogs(m, [
      { id: 'wl-legado', event: 'uazapi.messages', instance: 'atendimento-alex', tenant_id: null },
    ]);

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
  });

  it('inbound volta: fecha o alerta de silêncio em silêncio (sem notificar)', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    comSilencio(m);
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-1' });

    await m.service.verificarTodas();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);

    // Cliente voltou a aparecer.
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(0) });
    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.updateMany).toHaveBeenCalledWith({
      where: {
        instance_id: 'inst-uaz',
        tipo: 'inbound_silencioso',
        resolvido_em: null,
      },
      data: { resolvido_em: expect.any(Date) },
    });
    // Nada de "voltou a receber": ninguém foi avisado do problema fora do
    // alerta original, e um segundo aviso só faria barulho.
    expect(m.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(m.push.sendToUsers).toHaveBeenCalledTimes(1);

    // Fechou uma vez só: o ciclo seguinte não reescreve.
    await m.service.verificarTodas();
    expect(m.prisma.instanceAlert.updateMany).toHaveBeenCalledTimes(1);
  });

  it('instância que nunca alertou nesta vida do processo não escreve nada', async () => {
    const m = build([uaz()]);
    m.httpGet.mockReturnValue(of(uazStatusConectado));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(1) });

    await m.service.verificarTodas();

    expect(m.prisma.instanceAlert.updateMany).not.toHaveBeenCalled();
  });

  it('Evolution silenciosa: dispara o sync Evolution', async () => {
    const m = build([evo()]);
    m.httpGet.mockReturnValue(of(evoState('open')));
    m.prisma.message.findFirst.mockResolvedValue({ created_at: horasAtras(8) });
    m.prisma.message.count.mockResolvedValue(20);
    m.prisma.webhookLog.findFirst.mockResolvedValue({ id: 'wl-2' });

    await m.service.verificarTodas();

    expect(m.historySync.syncEvolutionInstance).toHaveBeenCalledWith(
      'inst-evo',
      HistorySyncService.RECONNECT_WINDOW_MS,
    );
    expect(m.historySync.syncInstance).not.toHaveBeenCalled();
    expect(m.prisma.instanceAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ instance_id: 'inst-evo', tipo: 'inbound_silencioso' }),
    });
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
