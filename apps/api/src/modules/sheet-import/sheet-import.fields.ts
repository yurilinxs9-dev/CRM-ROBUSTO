import { COMPANY_TYPE_LABEL } from './sheet-import.parser';

export const IMPORT_GROUP_NAME = 'Formulário Meta';

export interface ImportFieldSpec {
  key: string;
  nome: string;
  tipo: 'text' | 'select' | 'date';
  options?: string[];
  ordem: number;
}

/**
 * Definições de campo custom (escopo LEAD) que a importação garante no tenant.
 * Chaves são estáveis: são elas que entram em `Lead.dados_custom`.
 */
export const IMPORT_FIELDS: ReadonlyArray<ImportFieldSpec> = [
  {
    key: 'tipo_empresa',
    nome: 'Tipo de empresa',
    tipo: 'select',
    options: Object.values(COMPANY_TYPE_LABEL),
    ordem: 0,
  },
  { key: 'tipo_empresa_resposta', nome: 'Resposta original (MEI/LTDA)', tipo: 'text', ordem: 1 },
  { key: 'anos_consorcio', nome: 'Anos com consórcio', tipo: 'text', ordem: 2 },
  { key: 'estrutura_fisica', nome: 'Estrutura física', tipo: 'text', ordem: 3 },
  { key: 'qtd_vendedores', nome: 'Quantidade de vendedores', tipo: 'text', ordem: 4 },
  { key: 'producao_mensal', nome: 'Produção mensal', tipo: 'text', ordem: 5 },
  { key: 'cidade', nome: 'Cidade', tipo: 'text', ordem: 6 },
  { key: 'estado', nome: 'Estado', tipo: 'text', ordem: 7 },
  { key: 'form_data', nome: 'Data do formulário', tipo: 'date', ordem: 8 },
];
