# Fix: Lead por número (modo Individual) — fim da colisão de leads

## Problema
Cajuru Interiores (modo Individual, 1 pipeline "Padrao"). Lead é único por
`telefone + pipeline_id` (`schema.prisma:260`). Mesmo cliente que fala com dois
números diferentes vira **1 lead só**, dono = quem recebeu a primeira mensagem.

Mensagens `fromMe` (outbound do celular) de OUTRO operador são capturadas pelo
webhook e caem no mesmo lead (`webhook.processor.ts:355` upsert por
`telefone_pipeline_id`), com `visible_to_user_id = lead.responsavel_id` (`:552`).
→ Operador A vê as respostas do operador B "como se fossem dele". (55/229 leads
colididos em Cajuru.)

Não é leak de query — `findAll` filtra `responsavel_id = user.id` corretamente
(`leads.service.ts:302`). É o dado caindo num lead de dono errado.

## Solução escolhida: Lead por número (escopo)
Adicionar dimensão de escopo à identidade do lead.

- **Individual** (`pool_enabled=false`): `lead_scope = owner_user_id` da instância
  que recebeu. Cliente Eli no número da Isamara → lead A (Isamara). Eli no número
  do Alex → lead B (Alex). Dois cards separados.
- **Compartilhado** (`pool_enabled=true`): `lead_scope = tenant_id` (sentinela
  única). Comportamento atual intacto (1 lead por telefone+pipeline no tenant).

Ambos UUID, non-null → unique global funciona nos dois modos sem problema de NULL.

`lead_scope` é só identidade. `responsavel_id` continua independente — /claim,
/reassign e captação→atendente seguem funcionando (dono ≠ escopo).

## Mudanças

### 1. Schema (`schema.prisma` model Lead)
```
lead_scope String   // owner_user_id (Individual) ou tenant_id (Compartilhado)
@@unique([telefone, pipeline_id, lead_scope], name: "telefone_pipeline_scope")
// remove @@unique([telefone, pipeline_id])
@@index([lead_scope])
```

### 2. Webhook (`webhook.processor.ts` resolveLead/processMessage)
- `const leadScope = tenant?.pool_enabled ? tenantId : instance.owner_user_id;`
- upsert `where` → `telefone_pipeline_scope: { telefone, pipeline_id, lead_scope: leadScope }`
- `create.lead_scope = leadScope`
- `contacts.upsert`/`chats.update` (findFirst por telefone+tenant, `:1146`,`:1235`):
  desempatar por instância (owner_user_id == instance.owner_user_id) quando >1.

## Migration (PROD — DB perigoso, gated)
DB `dzjjpuwqhphgcevjvvbh` tem drift + `_prisma_migrations` poluído. NÃO usar
`migrate deploy`/`db push` cego (ver CLAUDE.md). Sequência manual atômica:

1. `ALTER TABLE "Lead" ADD COLUMN "lead_scope" text;`
2. Backfill (mantém leads atuais únicos → constraint adiciona limpo):
   - pool tenant → `lead_scope = tenant_id`
   - senão → `owner_user_id` da WhatsappInstance cujo `nome = instancia_whatsapp`
     (fallback `responsavel_id`, fallback `tenant_id`)
3. `ALTER TABLE "Lead" ALTER COLUMN "lead_scope" SET NOT NULL;`
4. `DROP` unique antigo `Lead_telefone_pipeline_id_key`;
   `CREATE UNIQUE INDEX ... ON "Lead"(telefone, pipeline_id, lead_scope);`
5. `CREATE INDEX ... ON "Lead"(lead_scope);`
6. `prisma migrate resolve --applied <nome>` (registrar, sem deploy).

Aplicar em transação única. Helper read-only: `scripts/introspect-db.mjs`.

## Split histórico (Fase B — gated, separado)
Leads já colididos (telefone+pipeline com mensagens de >1 owner_scope) precisam
ser separados: criar 1 lead por escopo e mover mensagens por dono da instância.
Script com **dry-run obrigatório**, revisado, rodado só em Cajuru primeiro.
Sem isso, a constraint nova só previne colisões FUTURAS — as 55 atuais persistem
até o split rodar.

## Ordem de deploy
Schema+código sobem juntos do migration (passo 1-6) — upsert novo depende da
unique nova existir. Depois Fase B.
