import { Prisma } from '@prisma/client';
import { AttributionService } from './attribution.service';

type Mock = ReturnType<typeof jest.fn>;

interface PrismaMock {
  leadAttribution: { create: Mock };
  trackedClick: { findUnique: Mock; update: Mock; upsert: Mock; deleteMany?: Mock };
  tenantSiteConfig: { findUnique: Mock; upsert: Mock };
}

function makeService(over: Partial<PrismaMock> = {}) {
  const prisma: PrismaMock = {
    leadAttribution: { create: jest.fn().mockResolvedValue({}) },
    trackedClick: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    tenantSiteConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }: { create: { site_token: string } }) =>
        Promise.resolve(create),
      ),
    },
    ...over,
  };
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const svc = new AttributionService(
    prisma as unknown as ConstructorParameters<typeof AttributionService>[0],
    cache as unknown as ConstructorParameters<typeof AttributionService>[1],
  );
  return { svc, prisma };
}

describe('AttributionService', () => {
  describe('extractClickCode', () => {
    const { svc } = makeService();

    it('acha o código no texto pré-preenchido do wa.me', () => {
      expect(svc.extractClickCode('Olá! Quero saber mais. (ref: A1B2C3D4)')).toBe('A1B2C3D4');
    });

    it('aceita espaçamento e caixa variados', () => {
      expect(svc.extractClickCode('oi (REF:  ab12)')).toBe('ab12');
    });

    it('devolve null para texto comum, vazio ou ausente', () => {
      expect(svc.extractClickCode('bom dia, tudo bem?')).toBeNull();
      expect(svc.extractClickCode('')).toBeNull();
      expect(svc.extractClickCode(null)).toBeNull();
      expect(svc.extractClickCode(undefined)).toBeNull();
    });

    it('ignora código fora do formato', () => {
      expect(svc.extractClickCode('(ref: ab)')).toBeNull(); // curto demais
      expect(svc.extractClickCode('(ref: com-hifen)')).toBeNull();
    });
  });

  describe('recordFirstTouch', () => {
    it('grava o lead já classificado', async () => {
      const { svc, prisma } = makeService();
      await svc.recordFirstTouch('lead-1', 'tenant-1', { gclid: 'Cj0KCQ', utm_campaign: '4242' });

      expect(prisma.leadAttribution.create).toHaveBeenCalledTimes(1);
      const data = prisma.leadAttribution.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        lead_id: 'lead-1',
        tenant_id: 'tenant-1',
        channel: 'GOOGLE_ADS',
        paid: true,
        campaign_id: '4242',
      });
    });

    it('engole P2002 — segundo toque não sobrescreve o primeiro', async () => {
      const create = jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );
      const { svc } = makeService({ leadAttribution: { create } });
      await expect(svc.recordFirstTouch('lead-1', 'tenant-1', { gclid: 'x' })).resolves.toBeUndefined();
    });

    it('nunca lança, mesmo com o banco fora do ar', async () => {
      const create = jest.fn().mockRejectedValue(new Error('connection refused'));
      const { svc } = makeService({ leadAttribution: { create } });
      await expect(svc.recordFirstTouch('lead-1', 'tenant-1', { gclid: 'x' })).resolves.toBeUndefined();
    });

    it('ignora entrada inválida sem tocar no banco', async () => {
      const { svc, prisma } = makeService();
      await svc.recordFirstTouch('lead-1', 'tenant-1', 'não é objeto');
      expect(prisma.leadAttribution.create).not.toHaveBeenCalled();
    });
  });

  describe('fromAdReferral', () => {
    it('traduz o anúncio do WhatsApp para a entrada comum', () => {
      const { svc } = makeService();
      expect(
        svc.fromAdReferral({
          source_id: '120251874055560237',
          title: 'Formatura',
          source_url: 'https://instagram.com/p/x',
          ctwa_clid: 'Afg',
          source_app: 'instagram',
          body: 'ignorado',
        }),
      ).toEqual({
        ad_id: '120251874055560237',
        ad_title: 'Formatura',
        ad_url: 'https://instagram.com/p/x',
        ctwa_clid: 'Afg',
        source_app: 'instagram',
      });
    });
  });

  describe('consumeClick', () => {
    it('devolve o payload e marca o clique como consumido', async () => {
      const findUnique = jest.fn().mockResolvedValue({
        id: 'click-1',
        clicked_at: new Date('2026-08-10T12:00:00Z'),
        consumed_at: null,
        payload: { gclid: 'Cj0KCQ', utm_source: 'google', utm_medium: 'cpc' },
      });
      const update = jest.fn().mockResolvedValue({});
      const { svc } = makeService({
        trackedClick: { findUnique, update, upsert: jest.fn() },
      });

      const input = await svc.consumeClick('tenant-1', 'A1B2C3D4');
      expect(input?.gclid).toBe('Cj0KCQ');
      expect(input?.clicked_at).toEqual(new Date('2026-08-10T12:00:00Z'));
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('devolve null quando o código não existe', async () => {
      const { svc } = makeService();
      expect(await svc.consumeClick('tenant-1', 'NAOEXISTE')).toBeNull();
    });

    it('não remarca clique já consumido', async () => {
      const update = jest.fn();
      const { svc } = makeService({
        trackedClick: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'click-1',
            clicked_at: new Date(),
            consumed_at: new Date(),
            payload: { gclid: 'x' },
          }),
          update,
          upsert: jest.fn(),
        },
      });
      await svc.consumeClick('tenant-1', 'A1B2C3D4');
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('registerClick', () => {
    it('ignora token de site desconhecido', async () => {
      const { svc, prisma } = makeService();
      await svc.registerClick({ t: 'token-invalido', k: 'A1B2C3D4', gclid: 'x' });
      expect(prisma.trackedClick.upsert).not.toHaveBeenCalled();
    });

    it('grava o clique quando o token confere', async () => {
      const { svc, prisma } = makeService({
        tenantSiteConfig: {
          findUnique: jest.fn().mockResolvedValue({ tenant_id: 'tenant-1', site_token: 'tok12345' }),
          upsert: jest.fn(),
        },
      });
      await svc.registerClick({
        t: 'tok12345',
        k: 'A1B2C3D4',
        gclid: 'Cj0KCQ',
        lp: 'https://site.com/lp',
        rf: 'https://google.com/',
      });

      expect(prisma.trackedClick.upsert).toHaveBeenCalledTimes(1);
      const args = prisma.trackedClick.upsert.mock.calls[0][0];
      expect(args.where.tenant_id_code).toEqual({ tenant_id: 'tenant-1', code: 'A1B2C3D4' });
      expect(args.create.payload).toMatchObject({
        gclid: 'Cj0KCQ',
        landing_url: 'https://site.com/lp',
        referrer: 'https://google.com/',
      });
      // Reenvio do mesmo código não reescreve o clique original.
      expect(args.update).toEqual({});
    });

    it('sem código não grava nada — é visita, não clique rastreável', async () => {
      const { svc, prisma } = makeService({
        tenantSiteConfig: {
          findUnique: jest.fn().mockResolvedValue({ tenant_id: 'tenant-1', site_token: 'tok12345' }),
          upsert: jest.fn(),
        },
      });
      await svc.registerClick({ t: 'tok12345', gclid: 'x' });
      expect(prisma.trackedClick.upsert).not.toHaveBeenCalled();
    });

    it('query malformada não lança', async () => {
      const { svc } = makeService();
      await expect(svc.registerClick({ t: 'curto' })).resolves.toBeUndefined();
      await expect(svc.registerClick(null)).resolves.toBeUndefined();
    });
  });

  describe('pruneOldClicks', () => {
    it('apaga só cliques com mais de 120 dias, e só de TrackedClick', async () => {
      const { svc, prisma } = makeService();
      await svc.pruneOldClicks();

      const where = prisma.trackedClick.deleteMany!.mock.calls[0][0].where;
      const cutoff: Date = where.created_at.lt;
      const dias = (Date.now() - cutoff.getTime()) / 864e5;
      expect(dias).toBeGreaterThan(119);
      expect(dias).toBeLessThan(121);
      // Nenhuma outra tabela é tocada pela poda.
      expect(prisma.leadAttribution.create).not.toHaveBeenCalled();
    });

    it('erro na poda não lança', async () => {
      const { svc } = makeService({
        trackedClick: {
          findUnique: jest.fn(),
          update: jest.fn(),
          upsert: jest.fn(),
          deleteMany: jest.fn().mockRejectedValue(new Error('db down')),
        },
      });
      await expect(svc.pruneOldClicks()).resolves.toBeUndefined();
    });
  });

  describe('getSiteToken', () => {
    it('reaproveita o token existente', async () => {
      const { svc, prisma } = makeService({
        tenantSiteConfig: {
          findUnique: jest.fn().mockResolvedValue({ tenant_id: 't1', site_token: 'ja-existe' }),
          upsert: jest.fn(),
        },
      });
      expect(await svc.getSiteToken('t1')).toBe('ja-existe');
      expect(prisma.tenantSiteConfig.upsert).not.toHaveBeenCalled();
    });

    it('cria um token na primeira vez', async () => {
      const { svc } = makeService();
      const token = await svc.getSiteToken('t1');
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    });
  });
});
