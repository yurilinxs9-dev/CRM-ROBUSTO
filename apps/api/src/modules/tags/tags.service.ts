import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  findAll(user: AuthUser, limit = 200, offset = 0) {
    return this.prisma.tag.findMany({
      where: { tenant_id: user.tenantId },
      orderBy: { nome: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Catálogo do tenant com quantos leads carregam cada tag — o número ao lado
   * do nome no painel de filtros.
   *
   * A contagem sai de `Lead.tags`, que é jsonb (array de strings), e NÃO de
   * LeadTag: quem grava é a ficha do lead, e a tabela de junção está vazia na
   * prática. `jsonb_exists` é a forma-função do operador `?`, que não dá para
   * usar em $queryRaw — o `?` colidiria com o placeholder de parâmetro.
   *
   * `jsonb_typeof = 'array'` é defensivo. Hoje todos os leads têm array, mas a
   * coluna aceita qualquer Json e um objeto solto derrubaria a query inteira.
   *
   * Tag sem lead nenhum aparece com 0 — sumir da lista esconderia justamente a
   * tag recém-criada que o usuário quer aplicar.
   */
  async findAllWithCounts(user: AuthUser) {
    return this.prisma.$queryRaw<Array<{ id: string; nome: string; cor: string; total: number }>>`
      SELECT t.id, t.nome, t.cor,
             (SELECT COUNT(*)::int
                FROM "Lead" l
               WHERE l.tenant_id = t.tenant_id
                 AND jsonb_typeof(l.tags) = 'array'
                 AND jsonb_exists(l.tags, t.nome)) AS total
        FROM "Tag" t
       WHERE t.tenant_id = ${user.tenantId}
       ORDER BY t.nome ASC
    `;
  }

  /**
   * Idempotente de propósito. O seletor de tags do lead cria a tag no mesmo
   * gesto em que o usuário digita um nome novo, e dois atendentes digitando a
   * mesma tag ao mesmo tempo é o caso normal, não a exceção. Com `create` puro
   * o segundo levava P2002 — traduzido pelo exception filter em "Resource
   * already exists", que na tela virava erro para uma ação que, do ponto de
   * vista de quem digitou, deu certo: a tag existe e é a que ele queria.
   *
   * O upsert casa exatamente com a unique `@@unique([tenant_id, nome])`, então
   * devolve a linha existente em vez de falhar. `update: {}` é intencional: se
   * a tag já existe, a cor dela NÃO é sobrescrita pelo default de quem digitou
   * o nome de novo.
   */
  async create(user: AuthUser, nome: string, cor: string) {
    const nomeLimpo = (nome ?? '').trim();
    if (!nomeLimpo) throw new BadRequestException('Nome da tag e obrigatorio');

    return this.prisma.tag.upsert({
      where: { tenant_id_nome: { tenant_id: user.tenantId, nome: nomeLimpo } },
      update: {},
      create: { nome: nomeLimpo, cor, tenant_id: user.tenantId },
    });
  }

  /**
   * Remove a tag do catálogo do tenant. O `findFirst` com tenant_id antes do
   * delete é o que impede apagar tag de outro tenant por id adivinhado — o
   * `delete` sozinho enxerga a tabela inteira.
   *
   * As linhas de LeadTag somem por cascade (`onDelete: Cascade` no schema).
   * O que NÃO some é o nome já gravado em `Lead.tags` (Json), que é uma lista
   * de strings desacoplada desta tabela: leads que já tinham a tag continuam
   * exibindo-a, ela apenas deixa de ser oferecida no seletor.
   */
  async remove(user: AuthUser, id: string) {
    const tag = await this.prisma.tag.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!tag) throw new NotFoundException('Tag nao encontrada');

    await this.prisma.tag.delete({ where: { id: tag.id } });
    return { id: tag.id };
  }
}
