import type { Broadcast, Tenant } from '@prisma/client';
import { campaignOptions } from './broadcast-config';
import { isWithinBroadcastWindow } from './broadcast-window';

export function dispatchWaitReason(b: Broadcast, tenant: Pick<Tenant, 'broadcast_window_start' | 'broadcast_window_end' | 'broadcast_window_days'> | null, now: Date): string | null {
  if (b.status !== 'running') return 'Campanha encerrada';
  if (!tenant) return 'Horário da empresa indisponível';
  const options = campaignOptions(b.segment);
  if (options.scheduled_at && new Date(options.scheduled_at) > now) return 'Aguardando a data programada';
  if (!isWithinBroadcastWindow(now, 'America/Sao_Paulo', tenant.broadcast_window_start, tenant.broadcast_window_end, tenant.broadcast_window_days)) return 'Fora do horário de envio da empresa';
  if (!isWithinBroadcastWindow(now, 'America/Sao_Paulo', options.window_start ?? 0, options.window_end ?? 24, options.window_days ?? [1,2,3,4,5,6,7])) return 'Fora do horário desta campanha';
  if (b.last_dispatch_at && now.getTime() - b.last_dispatch_at.getTime() < b.throttle_seconds * 1000) return 'Aguardando o intervalo entre envios';
  return null;
}
