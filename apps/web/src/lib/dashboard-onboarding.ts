/**
 * Quando o dashboard vazio e convite de onboarding e quando e so um painel
 * zerado.
 *
 * `totalLeads` vem RECORTADO pela visibilidade do usuario
 * (`dashboard.service.computeStats`): o operador conta a propria carteira mais
 * a nuvem. Zero para ele significa "carteira vazia" — trocar o dashboard
 * inteiro por "crie seu primeiro lead" esconde os numeros e ainda afirma que a
 * loja nao tem lead nenhum, quando pode ter milhares.
 *
 * O convite so faz sentido para quem SUPERVISIONA, com a MESMA definicao do
 * backend (`isManagerRole(role) && !focusMode`): gestor em modo foco esta
 * olhando a propria carteira, entao segue a regra do operador.
 */
export function deveMostrarOnboarding(params: {
  totalLeads: number;
  role: string | undefined;
  focusMode: boolean;
}): boolean {
  if (params.totalLeads !== 0) return false;
  return supervisiona(params.role, params.focusMode);
}

function supervisiona(role: string | undefined, focusMode: boolean): boolean {
  return (role === 'GERENTE' || role === 'SUPER_ADMIN') && !focusMode;
}
