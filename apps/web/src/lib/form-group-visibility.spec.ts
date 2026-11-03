import { formGroupVisible } from './form-group-visibility';
import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID } from './pl-sales';

test('questionário de consórcio só aparece no funil PL desse tenant', () => {
  expect(formGroupVisible('Formulário Consórcio', 'LEAD', PARTNERS_TENANT, PL_PIPELINE_ID)).toBe(true);
  expect(formGroupVisible('Formulário Consórcio', 'LEAD', PARTNERS_TENANT, 'partners')).toBe(false);
  expect(formGroupVisible('Formulário Consórcio', 'LEAD', PARTNERS_TENANT)).toBe(false);
});
test('preserva grupos anteriores, outros tenants e contatos', () => {
  expect(formGroupVisible('Formulário Meta', 'LEAD', PARTNERS_TENANT, PL_PIPELINE_ID)).toBe(true);
  expect(formGroupVisible('Principal', 'LEAD', PARTNERS_TENANT)).toBe(true);
  expect(formGroupVisible('Formulário Consórcio', 'LEAD', 'other')).toBe(true);
  expect(formGroupVisible('Formulário Consórcio', 'CONTATO', PARTNERS_TENANT)).toBe(true);
});
