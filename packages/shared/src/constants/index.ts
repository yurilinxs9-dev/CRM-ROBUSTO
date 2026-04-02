export const LEAD_TEMPERATURAS = ['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE'] as const;

export const USER_ROLES = ['SUPER_ADMIN', 'GERENTE', 'OPERADOR', 'VISUALIZADOR'] as const;

export const MESSAGE_TYPES = ['TEXT', 'AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACT'] as const;

export const MESSAGE_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const;

export const TEMPERATURA_COLORS: Record<string, string> = {
  FRIO: '#38bdf8',
  MORNO: '#fb923c',
  QUENTE: '#f97316',
  MUITO_QUENTE: '#ef4444',
};

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  GERENTE: 'Gerente',
  OPERADOR: 'Operador',
  VISUALIZADOR: 'Visualizador',
};
