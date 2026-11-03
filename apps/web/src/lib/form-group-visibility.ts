import { PARTNERS_TENANT } from './partners';
import { PL_PIPELINE_ID } from './pl-sales';
import type { FieldScope } from './field-render';

/** Only the new questionnaire is scoped; existing/custom groups keep their behavior. */
export function formGroupVisible(nome: string, scope: FieldScope, tenant?: string, pipeline?: string): boolean {
  return tenant !== PARTNERS_TENANT || scope !== 'LEAD' || nome !== 'Formulário Consórcio' || pipeline === PL_PIPELINE_ID;
}
