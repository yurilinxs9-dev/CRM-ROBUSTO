import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * O chat consome `/api/leads/:id/messages` → LeadsService.getMessages, e NÃO
 * o MessagesService.getHistory. O card de anúncio nasceu ligado só ao segundo,
 * então nunca apareceu na tela: os testes passavam, a conversa continuava sem
 * card. Estes testes cobrem o caminho que a tela realmente usa.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

const AD_METADATA = {
  raw: {
    data: {
      contextInfo: {
        externalAdReply: {
          title: 'Sofá sob medida',
          sourceApp: 'facebook',
          sourceUrl: 'https://fb.me/6YjKh7ZqC',
          sourceId: '120248557551840743',
        },
      },
    },
  },
};

/** Já normalizado pelo ingest — o formato que sobrevive à poda dos 30 dias. */
const AD_GRAVADO = {
  ad_referral: {
    title: 'Cozinha planejada',
    source_app: 'instagram',
    source_url: 'https://www.instagram.com/p/DbDxlGxs6jt/',
  },
};

function makeService(rows: unknown[]) {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        responsavel_id: 'u-alex',
        instancia_whatsapp: 'inst-A',
        is_private: false,
        assumed_at: null,
      }),
    },
    tenant: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ share_history_enabled: false, pool_enabled: false }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ focus_mode: false }) },
    message: { findMany: jest.fn().mockResolvedValue(rows) },
    conversation: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappInstance: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const media: any = { getSignedUrl: jest.fn().mockResolvedValue('https://signed/x') };
  const service = new LeadsService(
    prisma,
    {} as any, // instances
    {} as any, // cache
    {} as any, // gateway
    media,
    {} as any, // push
    {} as any, // outboundWebhooks
    {} as any, // assignment
    {} as any, // customFields
    {} as any, // autoActionsQueue
    {} as any, // kanbanIndividual
  );
  return { service, prisma };
}

const gerente: AuthUser = {
  id: 'u-gerente',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

const row = (over: Record<string, unknown>) => ({
  id: 'm1',
  lead_id: LEAD_ID,
  content: 'Olá! Posso ter mais informações sobre isso?',
  media_url: null,
  conversation_id: null,
  instance_name: 'inst-A',
  ...over,
});

describe('LeadsService.getMessages — card de anúncio', () => {
  it('DISCRIMINANTE: o endpoint do chat devolve ad_referral a partir do raw', async () => {
    const { service } = makeService([row({ metadata: AD_METADATA })]);

    const { messages } = await service.getMessages(LEAD_ID, gerente);

    expect(messages[0].ad_referral).toMatchObject({
      title: 'Sofá sob medida',
      source_app: 'facebook',
      source_id: '120248557551840743',
    });
  });

  it('DISCRIMINANTE: lê o bloco gravado no ingest, com o raw já podado', async () => {
    const { service } = makeService([row({ metadata: AD_GRAVADO })]);

    const { messages } = await service.getMessages(LEAD_ID, gerente);

    expect(messages[0].ad_referral).toMatchObject({ title: 'Cozinha planejada' });
  });

  it('o metadata cru não vaza na resposta', async () => {
    const { service } = makeService([row({ metadata: AD_METADATA })]);

    const { messages } = await service.getMessages(LEAD_ID, gerente);

    expect(messages[0]).not.toHaveProperty('metadata');
    expect(messages[0].id).toBe('m1');
  });

  it('mensagem comum sai com ad_referral null e mídia assinada', async () => {
    const { service } = makeService([
      row({ id: 'm2', metadata: { raw: { data: { conversation: 'oi' } } }, media_url: 'tenant/x.jpg' }),
    ]);

    const { messages } = await service.getMessages(LEAD_ID, gerente);

    expect(messages[0].ad_referral).toBeNull();
    expect(messages[0].media_url).toBe('https://signed/x');
  });
});
