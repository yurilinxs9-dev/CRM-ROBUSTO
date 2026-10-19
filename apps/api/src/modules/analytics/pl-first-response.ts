import { ForbiddenException } from '@nestjs/common';
import { isPlSalesOnly } from '../../common/access/pl-sales-access';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { PL_PIPELINE } from '../pl-sales/pl-sales.domain';

/**
 * One first incoming/reply pair per currently owned PL lead in the requested
 * window. An unanswered incoming message at handoff starts its clock at the
 * latest known assignment; earlier handling is not charged to this seller.
 * Replies must be sent by this user
 * in that same conversation. Native phone echoes are attributable only on an
 * exclusively owned instance, with an owned conversation and no shared pool.
 * PostgreSQL returns one aggregate row, never message/lead histories.
 */
export async function readPlFirstResponse(
  prisma: Pick<PrismaService, '$queryRaw'>,
  user: AuthUser,
  from: Date,
  to: Date,
) {
  if (!isPlSalesOnly(user)) throw new ForbiddenException('Relatório pessoal PL');

  const rows = await prisma.$queryRaw<Array<{
    total_conversations: number;
    samples: number;
    average_seconds: number | null;
    median_seconds: number | null;
  }>>`
    SELECT COUNT(*)::int AS total_conversations,
           COUNT(response.created_at)::int AS samples,
           AVG(EXTRACT(EPOCH FROM (response.created_at - first_incoming.started_at)))::float8 AS average_seconds,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (response.created_at - first_incoming.started_at))
           )::float8 AS median_seconds
    FROM "Lead" l
    LEFT JOIN LATERAL (
      SELECT MAX(activity.created_at) AS assigned_at
      FROM "LeadActivity" activity
      WHERE activity.lead_id = l.id AND activity.tenant_id = l.tenant_id
        AND activity.dados_depois->>'responsavel_id' = ${user.id}
        AND activity.dados_antes->>'responsavel_id' IS DISTINCT FROM activity.dados_depois->>'responsavel_id'
    ) assignment ON true
    JOIN LATERAL (
      SELECT clock.started_at, incoming.conversation_id, incoming.instance_name
      FROM "Message" incoming
      LEFT JOIN "Conversation" conversation
        ON conversation.id = incoming.conversation_id
        AND conversation.lead_id = l.id AND conversation.tenant_id = l.tenant_id
      CROSS JOIN LATERAL (
        SELECT GREATEST(incoming.created_at, l.assumed_at, assignment.assigned_at, conversation.assumed_at) AS started_at
      ) clock
      WHERE incoming.lead_id = l.id AND incoming.tenant_id = l.tenant_id
        AND incoming.direction = 'INCOMING' AND incoming.is_internal_note = false
        AND (incoming.visible_to_user_id IS NULL OR incoming.visible_to_user_id = ${user.id})
        AND (
          (incoming.conversation_id IS NULL AND incoming.instance_name = l.instancia_whatsapp)
          OR conversation.responsavel_id = ${user.id}
        )
        AND clock.started_at >= ${from} AND clock.started_at <= ${to}
        AND NOT EXISTS (
          SELECT 1 FROM "Message" handled
          WHERE handled.tenant_id = l.tenant_id AND handled.lead_id = l.id
            AND handled.conversation_id IS NOT DISTINCT FROM incoming.conversation_id
            AND handled.instance_name = incoming.instance_name
            AND handled.direction = 'OUTGOING' AND handled.is_internal_note = false
            AND handled.sender_type = 'user' AND handled.status IN ('SENT', 'DELIVERED', 'READ')
            AND handled.created_at >= incoming.created_at AND handled.created_at < clock.started_at
        )
      ORDER BY incoming.created_at, incoming.id
      LIMIT 1
    ) first_incoming ON true
    LEFT JOIN LATERAL (
      SELECT reply.created_at
      FROM "Message" reply
      WHERE reply.lead_id = l.id AND reply.tenant_id = l.tenant_id
        AND reply.direction = 'OUTGOING' AND reply.is_internal_note = false
        AND reply.sender_type = 'user'
        AND (
          reply.sent_by_user_id = ${user.id}
          OR (reply.sent_by_user_id IS NULL AND EXISTS (
            SELECT 1 FROM "WhatsappInstance" instance
            JOIN "Tenant" tenant ON tenant.id = instance.tenant_id
            JOIN "Conversation" owned ON owned.id = reply.conversation_id
            WHERE instance.tenant_id = l.tenant_id AND instance.nome = reply.instance_name
              AND instance.owner_user_id = ${user.id} AND tenant.pool_enabled = false
              AND owned.tenant_id = l.tenant_id AND owned.lead_id = l.id
              AND owned.responsavel_id = ${user.id} AND owned.instancia_whatsapp = instance.nome
              AND NOT EXISTS (
                SELECT 1 FROM "UserInstance" mapping
                WHERE mapping.instance_id = instance.id AND mapping.user_id <> ${user.id}
              )
          ))
        )
        AND reply.status IN ('SENT', 'DELIVERED', 'READ')
        AND (reply.visible_to_user_id IS NULL OR reply.visible_to_user_id = ${user.id})
        AND reply.conversation_id IS NOT DISTINCT FROM first_incoming.conversation_id
        AND reply.instance_name = first_incoming.instance_name
        AND reply.created_at >= first_incoming.started_at
        AND reply.created_at <= ${to}
      ORDER BY reply.created_at, reply.id
      LIMIT 1
    ) response ON true
    WHERE l.tenant_id = ${user.tenantId}
      AND l.pipeline_id = ${PL_PIPELINE}
      AND l.responsavel_id = ${user.id}
  `;

  const row = rows[0];
  const samples = Number(row?.samples ?? 0);
  const total = Number(row?.total_conversations ?? 0);
  const average = samples > 0 && row?.average_seconds != null ? Number(row.average_seconds) : null;
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    total_conversations: total,
    unanswered: total - samples,
    average_seconds: average,
    samples,
    users: samples > 0 && average !== null && row?.median_seconds != null ? [{
      id: user.id,
      nome: user.nome,
      answered: samples,
      avg_seconds: Math.round(average),
      median_seconds: Math.round(Number(row.median_seconds)),
    }] : [],
  };
}
