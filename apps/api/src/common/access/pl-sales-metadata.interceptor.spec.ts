import { firstValueFrom, of } from 'rxjs';
import { PlSalesMetadataInterceptor } from './pl-sales-metadata.interceptor';

describe('restricted metadata responses', () => {
  const user = { tenantId: 'a44772ed-1382-4400-84fc-3fa350e23e42', role: 'OPERADOR', plSalesOnly: true };
  const run = (url: string, value: unknown, actor = user) => {
    const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, method: 'GET', user: actor }) }) };
    return firstValueFrom(new PlSalesMetadataInterceptor().intercept(context as never, { handle: () => of(value) }));
  };
  it.each(['/api/pipelines', '/api/pipelines/6f749216-8d83-44ed-8fd0-1c57720c9f11', '/api/sectors', '/api/tags?with_counts=true'])('removes tenant-wide aggregate counts from %s', async path => {
    const data = [{ id: 'metadata', total: 91, _count: { leads: 83, users: 12 }, stages: [{ id: 'stage', _count: { leads: 19 } }] }];
    expect(await run(path, data)).toEqual([{ id: 'metadata', stages: [{ id: 'stage' }] }]);
    expect(data[0]._count.leads).toBe(83);
  });
  it('preserves other profiles and scoped business totals', async () => {
    const data = { total: 3, _count: { leads: 3 } };
    expect(await run('/api/pl-sales', data)).toBe(data);
    expect(await run('/api/pipelines', data, { ...user, plSalesOnly: false })).toBe(data);
  });
});
