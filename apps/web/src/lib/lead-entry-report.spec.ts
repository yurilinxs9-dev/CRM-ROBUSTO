import { entryReportParams, currentMonthRange } from './lead-entry-report';

it('inclui os dias completos em Brasília e preserva os demais filtros', () => {
  expect(entryReportParams({ created_from: '2026-09-01', created_to: '2026-09-25', origem: 'MANUAL' })).toEqual({
    created_from: '2026-09-01T00:00:00.000-03:00',
    created_to: '2026-09-25T23:59:59.999-03:00', origem: 'MANUAL',
  });
});

it('usa a data de Brasília mesmo quando UTC já virou o mês', () => {
  expect(currentMonthRange(new Date('2026-10-01T01:00:00Z'))).toEqual({ created_from: '2026-09-01', created_to: '2026-09-30' });
});
