import { BadRequestException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

function makeService() {
  const prisma = { tenant: { update: jest.fn().mockResolvedValue({}) } };
  return { svc: new TenantsService(prisma as never), prisma };
}

const CALLER = { tenantId: 'tenant-1' } as never;

describe('TenantsService.updateSettings — janela do follow-up', () => {
  it('grava as três colunas da janela', async () => {
    const { svc, prisma } = makeService();
    await svc.updateSettings(CALLER, {
      broadcast_window_start: 8,
      broadcast_window_end: 20,
      broadcast_window_days: [1, 2, 3, 4, 5, 6],
    });

    const data = prisma.tenant.update.mock.calls[0][0].data;
    expect(data.broadcast_window_start).toBe(8);
    expect(data.broadcast_window_end).toBe(20);
    expect(data.broadcast_window_days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('recusa janela invertida', async () => {
    // start >= end nunca abre: o disparo pararia para sempre e o gerente não
    // teria como descobrir por quê — o cron não tem tela de erro.
    const { svc, prisma } = makeService();
    await expect(svc.updateSettings(CALLER, { broadcast_window_start: 18, broadcast_window_end: 9 })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('recusa janela invertida quando só um lado vem no payload', async () => {
    // Editar apenas o início tem que ser validado contra o fim JÁ gravado,
    // senão dá para inverter a janela em duas requisições válidas.
    const { svc, prisma } = makeService();
    (prisma.tenant as unknown as { findUnique: jest.Mock }).findUnique = jest
      .fn()
      .mockResolvedValue({ broadcast_window_start: 9, broadcast_window_end: 18 });

    await expect(svc.updateSettings(CALLER, { broadcast_window_start: 19 })).rejects.toThrow(BadRequestException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('recusa lista de dias vazia', async () => {
    // Nenhum dia ativo = disparo morto em silêncio. Para parar, existe o Pausar.
    const { svc } = makeService();
    await expect(svc.updateSettings(CALLER, { broadcast_window_days: [] })).rejects.toThrow(BadRequestException);
  });

  it('não toca na janela quando o payload não fala dela', async () => {
    const { svc, prisma } = makeService();
    await svc.updateSettings(CALLER, { pool_enabled: true });

    const data = prisma.tenant.update.mock.calls[0][0].data;
    expect(data).toEqual({ pool_enabled: true });
  });
});
