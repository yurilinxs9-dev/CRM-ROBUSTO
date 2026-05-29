import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { API_SCOPES } from './scopes';
import type { ApiAuth } from './api-auth';
import { generateApiKey, hashApiKey } from './api-key.util';

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lista chaves do tenant — nunca expõe o hash nem o token em claro. */
  async list(tenantId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        active: true,
        last_used_at: true,
        revoked_at: true,
        created_at: true,
      },
    });
    return keys;
  }

  /**
   * Cria uma nova chave. Retorna o token em claro UMA única vez — o cliente
   * deve guardá-lo; nós só persistimos o hash.
   */
  async create(tenantId: string, body: unknown) {
    const data = createKeySchema.parse(body);
    const { token, prefix, hash } = generateApiKey();

    const created = await this.prisma.apiKey.create({
      data: {
        tenant_id: tenantId,
        name: data.name,
        key_hash: hash,
        prefix,
        scopes: data.scopes,
      },
      select: { id: true, name: true, prefix: true, scopes: true, created_at: true },
    });

    return { ...created, token };
  }

  /** Revoga (desativa) uma chave. Idempotente. */
  async revoke(tenantId: string, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, tenant_id: tenantId } });
    if (!key) throw new NotFoundException('API key não encontrada');
    await this.prisma.apiKey.update({
      where: { id },
      data: { active: false, revoked_at: new Date() },
    });
    return { ok: true };
  }

  /** Métricas de uso por chave nos últimos 7 dias (total + erros 4xx/5xx). */
  async usage(tenantId: string) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totals, errors] = await Promise.all([
      this.prisma.apiRequestLog.groupBy({
        by: ['api_key_id'],
        where: { tenant_id: tenantId, created_at: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.apiRequestLog.groupBy({
        by: ['api_key_id'],
        where: { tenant_id: tenantId, created_at: { gte: since }, status_code: { gte: 400 } },
        _count: { _all: true },
      }),
    ]);
    const errMap = new Map(errors.map((e) => [e.api_key_id, e._count._all]));
    return {
      window_days: 7,
      by_key: totals.map((t) => ({
        api_key_id: t.api_key_id,
        total: t._count._all,
        errors: errMap.get(t.api_key_id) ?? 0,
      })),
    };
  }

  /**
   * Verifica um token em claro vindo do header Authorization.
   * Retorna o contexto de auth ou null se inválido/revogado.
   * Atualiza last_used_at em background (não bloqueia a requisição).
   */
  async verify(token: string): Promise<ApiAuth | null> {
    if (!token || !token.startsWith('crmk_')) return null;
    const hash = hashApiKey(token);
    const key = await this.prisma.apiKey.findFirst({
      where: { key_hash: hash, active: true },
      select: { id: true, tenant_id: true, scopes: true },
    });
    if (!key) return null;

    this.prisma.apiKey
      .update({ where: { id: key.id }, data: { last_used_at: new Date() } })
      .catch((err) => this.logger.warn(`Falha ao atualizar last_used_at: ${String(err)}`));

    return {
      keyId: key.id,
      tenantId: key.tenant_id,
      scopes: key.scopes as ApiAuth['scopes'],
    };
  }
}
