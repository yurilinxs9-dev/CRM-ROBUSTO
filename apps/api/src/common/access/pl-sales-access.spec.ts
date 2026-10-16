import { isPlSalesOnly } from './pl-sales-access';

describe('isPlSalesOnly', () => {
  const tenantId = 'a44772ed-1382-4400-84fc-3fa350e23e42';
  it.each([
    [{ tenantId, role: 'OPERADOR', plSalesOnly: true }, true],
    [{ tenantId, role: 'OPERADOR' }, false],
    [{ tenantId, role: 'OPERADOR', plSalesOnly: false }, false],
    [{ tenantId: 'other', role: 'OPERADOR', plSalesOnly: true }, false],
    [{ tenantId, role: 'GERENTE', plSalesOnly: true }, false],
    [{ tenantId, role: 'SUPER_ADMIN', plSalesOnly: true }, false],
    [{ tenantId, role: 'VISUALIZADOR', plSalesOnly: true }, false],
  ])('scopes restriction to the opt-in PL operator (%j)', (user, restricted) => {
    expect(isPlSalesOnly(user)).toBe(restricted);
  });
});
