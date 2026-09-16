# Parceiros Taynara Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Execute tasks in order with review.

**Goal:** Disponibilizar cadastro de parceiros, vendas diárias e meta mensal somente no workspace da Taynara.
**Architecture:** NestJS API com tabelas aditivas Prisma e gate fixo por tenant, Next.js com componentes existentes. Não reutilizar produção declarada dos leads como venda real.
**Tech Stack:** NestJS, Prisma 5, PostgreSQL, Next.js 14, React Query, Zod.
**Spec:** docs/superpowers/specs/2026-09-16-parceiros-taynara-design.md

## Global Constraints

Tenant exclusivo a44772ed-1382-4400-84fc-3fa350e23e42; unidade Vendas dos parceiros (R$); não definir meta inicial; não inserir dados reais ou fictícios em produção. Uma linha por parceiro/data, substituição com versão esperada, dinheiro Decimal(16,2), auditoria atômica, fuso America/Sao_Paulo. Isolamento backend e frontend. Sem any. Preservar arquivos locais existentes. Migration somente objetos novos, nunca migrate deploy/db push. Arquivamento não exclui histórico.

## Contrato compartilhado

API autenticada /api/partners. Valores monetários retornados como strings decimais canônicas, datas YYYY-MM-DD, mês YYYY-MM. Backend deriva tenantId do AuthUser.

GET ?month=YYYY-MM retorna:
```ts
interface PartnerDashboard {
 month: string; today: string;
 partners: Array<{id:string; name:string; contact:string|null; phone:string|null; notes:string|null; joined_on:string; active:boolean; owner_id:string|null; owner_name:string|null; lead_id:string|null; version:number; monthly_total:string}>;
 entries: Array<{id:string; partner_id:string; date:string; amount:string; note:string|null; version:number; updated_at:string; updated_by_name:string}>;
 goal: {amount:string; version:number}|null;
 summary: {total:string; today_total:string; target:string|null; remaining:string|null; excess:string; percentage:number|null; days_remaining:number; required_per_day:string|null; active_partners:number; producing_partners:number};
 daily: Array<{date:string; total:string; accumulated:string}>;
 ranking: Array<{id:string; name:string; total:string}>;
 members: Array<{id:string; name:string}>;
}
```
GET /candidates?search= retorna Array<{id:string; name:string; company:string|null; phone:string}> dos leads na etapa Cadastro (id 8c5ca72b-8e29-4ad8-aa3c-6ffb98dc158a) do workspace sem parceiro vinculado, limite 30. Nome/telefone buscáveis. Não disponibilizar outros estágios ou outros tenants.
POST / (GERENTE+) {name, contact?, phone?, notes?, joined_on, owner_id?, lead_id?} cria parceiro. Validar todos os vínculos, preencher dados do lead quando escolhido é responsabilidade da UI, nunca importar dados_custom.producao_mensal.
PATCH /:id (GERENTE+) {expectedVersion, name?, contact?, phone?, notes?, joined_on?, owner_id?, active?} atualiza com controle de concorrência; não trocar lead vinculado.
PUT /:id/production/:date (OPERADOR+) {amount:string, note?:string, expectedVersion:number}: expectedVersion=0 cria, >=1 substitui versão exata. Colisão retorna 409, não sobrescrever. Parceiro inativo não recebe lançamento novo; correção histórica de inativo permitida GERENTE+. Datas futuras proibidas, zero explicitamente permitido. Montante máximo 999999999999.99. Lançamento não apaga registro.
PUT /goals/:month (GERENTE+) {amount:string, expectedVersion:number}: >=0, controle de concorrência, ausência de meta preservada até definir.
GET /audit?partner_id= (GERENTE+) até 100 últimas alterações do tenant, retorna Array<{id:string; action:string; entity_id:string; actor_name:string; created_at:string; before:unknown; after:unknown}>. Valores sem segredos.
Erros Zod -> 400 com mensagem legível; fora do tenant -> 403; objeto de outro tenant -> 404; concorrência -> 409. Nenhum tenant recebido no body. Auditoria na mesma transação. Atualização em tempo real via evento partners:updated somente sala do tenant, com React Query invalidation; fallback refetch 30s.

### Task 1: Backend, regras de negócio e migration

Files: apps/api/src/modules/partners/{partners.module,partners.controller,partners.service,partners.domain,partners.schemas}.ts e testes .spec.ts; apps/api/src/app.module.ts; apps/api/prisma/schema.prisma; apps/api/prisma/migrations/20260916180000_partner_production/migration.sql; apps/api/scripts/apply-partner-production.mjs.

- [ ] Escrever testes vermelhos para gate de tenant, dinheiro, datas reais, meses, ranking e metas.
```ts
expect(() => assertPartnerTenant('other')).toThrow();
expect(moneySchema.safeParse('0.001').success).toBe(false);
expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
// summary for total=12000000 and target=15000000 must report remaining=3000000.
// no target -> null percentage and required_per_day; exceeded target -> remaining=0.
```
- [ ] Executar via npm test --workspace=@crm/api -- --runInBand partners; confirmar RED.
- [ ] Implementar funções puras e APIs com contratos acima, testes do serviço (dependência Prisma mockada somente no limite). Cobrir vínculo cross-tenant, papel de visualizador/operador, dupla submissão 409, concorrência de versão, inativo, transação com auditoria.
- [ ] Adicionar quatro modelos: SalesPartner, PartnerDailyProduction, PartnerMonthlyGoal, PartnerProductionAudit. Relações a Tenant, parceiro e autor; IDs uuid; índices por tenant/mês/data; FK composta tenant/partner para isolamento. Produção única tenant/partner/date. Auditoria JSON de antes/depois. Se relações existentes exigirem backrelations Prisma, apenas schema lógico; DDL não altera tabelas existentes.
- [ ] Gerar SQL por diff entre schema de HEAD e novo, offline, filtrar somente objetos novos. Script apply baseado no padrão existente, exige DIRECT_URL, dry-run padrão e --apply explícito, checa estrutura existente sem assumir que contagens vivas não podem mudar. Registrar migration com migrate resolve depois, não executar migrate deploy.
- [ ] Gerar Prisma e executar testes, typecheck e lint quiet. Revisão da tarefa antes da UI.

### Task 2: Tela, navegação e contratos

Files: apps/web/src/app/(dashboard)/partners/page.tsx; apps/web/src/components/partners/*; apps/web/src/lib/partners.ts e teste; apps/web/src/components/layout/{sidebar,command-palette}.tsx.

- [ ] Escrever testes vermelhos de gate de navegação por tenant e parsing BRL: 1.234,56 -> 1234.56; vazio inválido; rejeitar 1,001 e negativos; date input no mês selecionado. Funções reais fora de JSX.
- [ ] Implementar tela exclusiva e guard que não dispara queries fora do tenant. Chaves React Query incluem tenant e mês. Visões Resumo/Parceiros/Lançamentos e histórico acessível a gerentes.
- [ ] Resumo com cards, ranking, gráfico SVG acessível diário/acumulado, seletor de mês, meta sem default, dias corridos incluindo hoje e necessidade diária. Sem fake data. Estados de erro/loading/empty claros. Valores com Intl.NumberFormat pt-BR.
- [ ] Formulários responsivos de cadastro/edição/arquivamento (GERENTE+), importação selecionada da lista de candidatos Cadastro, responsável, data de cadastro. Lançamento por parceiro/data, carregar total anterior e versão ao selecionar, texto explícito substituir total; bloqueio de clique duplo. Não resetar drafts em refetch de fundo. Exibir 409 e pedir recarregar antes de substituir. Inativo só gerente corrige histórico existente.
- [ ] Meta por mês GERENTE+ com versão; histórico das alterações (até 100); leitura para VISUALIZADOR. Rúbia OPERADOR pode lançar e ver resumo/rede inteira, sem configurar metas/cadastro.
- [ ] Atualizar sidebar e palette com gate compartilhado e tenant. Rota direta mostra indisponível sem buscar dados.
- [ ] Executar testes web, typecheck e lint; validar build e navegação visual com fixtures somente locais.

### Task 3: Revisão integrada, entrega e ativação

- [ ] Revisão completa do diff, contrato UI/API e isolamento real; corrigir achados com revisão da correção.
- [ ] Build API e web; testes focados e de navegação adjacente; SQL somente novas tabelas.
- [ ] Preparar publicação com backup e rollback, verificar git remoto e estado VPS, preservar alterações alheias. Aplicar migration aditiva e registrar; publicar backend e frontend somente após revisão concluída, conforme autorização da tarefa e ferramentas disponíveis.
- [ ] Verificar health, 403 de tenant alheio, leitura no tenant Taynara sem seed, menu disponível e painel vazio. Entregar status verdadeiro, pendências e link.
