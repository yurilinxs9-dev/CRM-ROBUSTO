/**
 * Identidade juridica da empresa que opera o CRM.
 *
 * Vive num arquivo so porque esses dados aparecem espalhados pelos dois
 * documentos legais (privacidade e termos) e porque errar um deles em UM lugar
 * e acertar no outro e pior do que nao ter o dado: uma politica que se
 * contradiz sobre quem e o controlador nao serve nem para o usuario nem para o
 * App Review da Meta.
 *
 * O que estiver com PENDENTE precisa ser preenchido ANTES de publicar. O
 * componente de documento legal renderiza um aviso visivel no lugar do campo
 * faltante em vez de imprimir a palavra crua no meio de uma frase juridica.
 */

/** Marcador de campo ainda nao preenchido. Ver `pendente()`. */
export const PENDENTE = '__PENDENTE__' as const;

export interface DadosEmpresa {
  /** Nome comercial do produto — o que o usuario ve na tela. */
  nomeProduto: string;
  /** Razao social completa, como registrada na Receita. */
  razaoSocial: string;
  /** CNPJ formatado (00.000.000/0000-00). */
  cnpj: string;
  /** Endereco da sede, uma linha. Exigido pela LGPD para contato do controlador. */
  endereco: string;
  /** E-mail de contato geral de privacidade. Precisa existir de verdade e ser lido. */
  emailPrivacidade: string;
  /** E-mail de suporte comercial/contratual. */
  emailSuporte: string;
  /**
   * Encarregado pelo tratamento de dados (DPO), art. 41 da LGPD.
   * Pode ser uma pessoa ou um setor; o que a lei exige e que seja identificavel.
   */
  encarregado: string;
  /** Dominio publico onde os documentos legais ficam servidos, sem barra final. */
  dominioPublico: string;
  /** Foro eleito para dirimir conflitos (comarca/UF). */
  foro: string;
}

export const EMPRESA: DadosEmpresa = {
  nomeProduto: 'CRM Yurilins',
  razaoSocial: PENDENTE,
  cnpj: PENDENTE,
  endereco: PENDENTE,
  emailPrivacidade: PENDENTE,
  emailSuporte: PENDENTE,
  encarregado: PENDENTE,
  dominioPublico: 'https://painel.gestaorm.online',
  foro: PENDENTE,
};

/** true quando o campo ainda nao foi preenchido. */
export function pendente(valor: string): boolean {
  return valor === PENDENTE;
}

/**
 * Data da ultima revisao dos documentos. Muda junto com o texto — a Meta e a
 * ANPD olham essa data para saber se a politica acompanha o produto.
 */
export const ATUALIZADO_EM = '11 de setembro de 2026';

/** Todos os campos obrigatorios ja preenchidos? Usado para o aviso de rascunho. */
export function empresaCompleta(): boolean {
  return Object.values(EMPRESA).every((v) => !pendente(v));
}

/**
 * Devolve o valor do campo ou um marcador visivel quando ele ainda nao existe.
 *
 * A alternativa — deixar a string vazia — produziria frases como "A empresa ,
 * inscrita no CNPJ , e a controladora", que parecem prontas num print e passam
 * despercebidas na revisao. O marcador entre colchetes grita na tela e o
 * renderizador de documento o destaca em amarelo.
 */
export function campo(valor: string, rotulo: string): string {
  return pendente(valor) ? `[PREENCHER: ${rotulo}]` : valor;
}

/** Casa com o marcador de `campo()`, para o destaque visual no documento. */
export const MARCADOR_PENDENTE = /(\[PREENCHER:[^\]]+\])/g;
