import { IMPORT_FIELDS, IMPORT_GROUP_NAME, type ImportFieldSpec } from './sheet-import.fields';
import { mapRow, type MapResult } from './sheet-import.parser';
import { CONSORTIUM_FIELDS, mapConsortiumRow } from './consortium-sheet.parser';
import { PL_PIPELINE, PL_TENANT } from '../pl-sales/pl-sales.domain';

export interface SheetImportSource {
  prefix: string;
  group: string;
  fields: ReadonlyArray<ImportFieldSpec>;
  map: (row: Record<string, string>) => MapResult;
  tenantId?: string;
  pipelineId?: string;
  conservativeDedupe?: boolean;
}
export const PARTNER_SOURCE: SheetImportSource = {
  prefix: 'SHEET_IMPORT', group: IMPORT_GROUP_NAME, fields: IMPORT_FIELDS, map: mapRow,
};
export const CONSORTIUM_SOURCE: SheetImportSource = {
  prefix: 'PL_SHEET_IMPORT', group: 'Formulário Consórcio', fields: CONSORTIUM_FIELDS,
  map: mapConsortiumRow, tenantId: PL_TENANT, pipelineId: PL_PIPELINE, conservativeDedupe: true,
};
