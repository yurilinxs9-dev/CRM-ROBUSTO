/**
 * Ordem dos cards dentro de uma coluna do Kanban.
 *
 * Manda a `position` — o valor que o usuário definiu arrastando o card. Ela é
 * fracionária e cresce para baixo, então menor = mais acima. Recência entra só
 * como desempate, para leads que ainda compartilham a mesma posição.
 *
 * Antes a coluna era ordenada só por `ultima_interacao`: o arrasto vertical
 * gravava a posição no banco e a tela reordenava por cima, jogando o card de
 * volta. Era por isso que o funil parecia respeitar apenas a ordem de chegada.
 */

export interface OrderableLead {
  position?: number | null;
  ultima_interacao?: string | null;
}

/** Sem posição, o lead vai para o fim — não para o topo por acidente. */
const positionOf = (lead: OrderableLead): number =>
  typeof lead.position === 'number' ? lead.position : Number.MAX_SAFE_INTEGER;

const interactedAt = (lead: OrderableLead): number =>
  lead.ultima_interacao ? new Date(lead.ultima_interacao).getTime() : 0;

/** Comparador para `Array.prototype.sort` dentro de uma coluna. */
export function compareLeadsInStage(a: OrderableLead, b: OrderableLead): number {
  const byPosition = positionOf(a) - positionOf(b);
  if (byPosition !== 0) return byPosition;
  return interactedAt(b) - interactedAt(a);
}

/**
 * Posição que põe o card acima de todos os da coluna de destino. Espelha
 * `topPositionOf` do backend, que é quem decide quando a posição não vem no
 * pedido — aqui é só para a atualização otimista não piscar o card no lugar
 * errado até a resposta chegar.
 */
export function topPositionFor(stageLeads: OrderableLead[]): number {
  const positions = stageLeads
    .map((l) => l.position)
    .filter((p): p is number => typeof p === 'number');
  if (positions.length === 0) return 1000;
  return Math.min(...positions) - 1000;
}
