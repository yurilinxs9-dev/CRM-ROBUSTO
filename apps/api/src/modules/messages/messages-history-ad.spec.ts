import { MessagesService } from './messages.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * O card de anúncio é derivado na leitura, não gravado no ingest — ver
 * docs/specs/anuncio-na-conversa.md. Estes testes exercitam `getHistory()` de
 * verdade: um teste que chamasse só `extractAdReferral` passaria igual sem o
 * serviço nunca ter sido ligado ao extrator.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const AD_METADATA = {
  raw: {
    data: {
      contextInfo: {
        externalAdReply: {
          title: 'Viva uma formatura inesquecível! ✨',
          body: 'Tudo começa com uma decisão…',
          sourceApp: 'instagram',
          sourceUrl: 'https://www.instagram.com/p/DbDxlGxs6jt/',
          sourceId: '120251874055560237',
        },
      },
    },
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
      }),
    },
    whatsappInstance: { findMany: jest.fn().mockResolvedValue([]) },
    conversation: { findMany: jest.fn().mockResolvedValue([]) },
    tenant: { findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }) },
    user: { findUnique: jest.fn().mockResolvedValue({ focus_mode: false }) },
    message: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const media: any = { getSignedUrl: jest.fn().mockResolvedValue('https://signed/x') };
  const service = new MessagesService(
    {} as any, // http
    { get: jest.fn().mockReturnValue('') } as any, // config
    prisma,
    media,
    {} as any, // audio
    { emitNewMessage: jest.fn() } as any, // gateway
    {} as any, // cache
    {} as any, // mediaPipeline
    { add: jest.fn() } as any, // sendQueue
    {} as any, // outboundWebhooks
    {} as any, // push
    {} as any, // conversations
  );
  return { service, prisma };
}

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('MessagesService.getHistory — card de anúncio', () => {
  it('DISCRIMINANTE: mensagem com anúncio no metadata sai com ad_referral preenchido', async () => {
    const { service } = makeService([
      {
        id: 'm1',
        lead_id: LEAD_ID,
        content: 'Oi, queria saber o preço',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].ad_referral).toMatchObject({
      title: 'Viva uma formatura inesquecível! ✨',
      source_app: 'instagram',
      source_id: '120251874055560237',
      source_url: 'https://www.instagram.com/p/DbDxlGxs6jt/',
    });
  });

  it('DISCRIMINANTE: o metadata cru não vaza mais na resposta', async () => {
    const { service } = makeService([
      {
        id: 'm1',
        lead_id: LEAD_ID,
        content: 'Oi',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0]).not.toHaveProperty('metadata');
    expect(messages[0].id).toBe('m1');
    expect(messages[0].content).toBe('Oi');
  });

  it('mensagem comum sai com ad_referral null', async () => {
    const { service } = makeService([
      {
        id: 'm2',
        lead_id: LEAD_ID,
        content: 'bom dia',
        media_url: null,
        media_archived: false,
        media_thumbnail_path: null,
        metadata: { raw: { data: { conversation: 'bom dia' } } },
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].ad_referral).toBeNull();
  });

  it('mensagem de mídia continua com a URL assinada, e ganha ad_referral', async () => {
    const { service } = makeService([
      {
        id: 'm3',
        lead_id: LEAD_ID,
        content: null,
        media_url: 'tenant/x.jpg',
        media_archived: false,
        media_thumbnail_path: null,
        metadata: AD_METADATA,
      },
    ]);

    const { messages } = await service.getHistory(LEAD_ID, alex);

    expect(messages[0].media_url).toBe('https://signed/x');
    expect(messages[0].ad_referral).not.toBeNull();
  });
});
