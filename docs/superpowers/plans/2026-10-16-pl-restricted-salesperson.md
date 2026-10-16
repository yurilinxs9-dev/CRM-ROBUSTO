# Perfil restrito de vendedora PL — Implementation Plan

**Goal:** preparar um perfil opt-in para a futura vendedora do tenant a44772ed-1382-4400-84fc-3fa350e23e42. Só carteira própria, vendas próprias e meta individual; sem parceiros, totais gerais ou dados de colegas.
**Architecture:** User.pl_sales_only boolean default false; campo servidor AuthUser.plSalesOnly. Política de API após autenticação, restrição de carteira nas consultas e WebSocket separado. Configuração por gestão em Equipe. Nenhum usuário ativado agora.
**Tech Stack:** NestJS/Prisma, Next.js, Jest serial com RAM limitada.
**Spec:** pedido nesta conversa e esclarecimento explícito do usuário: vendedora ainda indefinida; deixar regra pronta e só definir a pessoa depois.

## Constraints
- Taynara, Paloma, Rúbia e Lívia conservam seus acessos atuais. Não inferir que Lívia/Rúbia são a nova vendedora.
- Só OPERADOR desse tenant pode receber o perfil. Gestão pode configurar; usuário não pode alterar o próprio perfil. Default false em criação/vínculo, sem opt-in automático.
- Leads próprios = responsável atual; novos contatos do número pessoal dela recebem sua responsabilidade. Central de captação continua sem responsável e distribuição humana. Transferência posterior retira acesso anterior.
- Vendas/objetivos PL já têm escopo individual para operador; manter sem totais/ranking de terceiros.
- Esconder navegação e negar APIs bloqueadas; não usar apenas proteção visual. WebSocket não pode entregar mensagem de terceiro ou permitir join arbitrário.
- SQL aditivo apenas uma coluna default false; direct URL, transação, idempotência, zero alterações de flags existentes. Não usar migrate deploy/db push. Rollback: desativar flag, reimplantar código anterior; coluna pode permanecer.
- Não enviar mensagens externas, não criar vendas falsas, não ativar perfil em usuários atuais, preservar scripts diag-lucas não rastreados.

## Tasks
- [x] 1. Campo de perfil, autenticação com valor do banco, endpoints de equipe com validação/limpeza de cache e sessões; teste de default/tenant/role/autoconfiguração.
- [x] 2. Política de acesso restrito API: deny-by-default para áreas gerais/financeiro/parceiros, allowlist de atendimento com checagem de propriedade. Listas e mensagens limitadas ao responsável atual, entrada pessoal preservada. Testes IDOR, busca e filtro adulterado.
- [x] 3. WebSocket: perfil verificado no banco, fora de broadcast tenant/lead; entregar eventos só ao dono atual e impedir joins arbitrários. Invalidar conexões em mudança de perfil.
- [x] 4. Frontend: opção na Equipe, sessão atualizada pelo /me, menus/rotas limitados, página inicial Consórcio PL, vendas/meta própria e controles de atribuição bloqueados para perfil restrito.
- [ ] 5. Typecheck/lint/testes focados e revisão independente. Aplicar coluna sem ativar ninguém, publicar e verificar API/contas atuais; smoke de perfil com fixtures isoladas/revertidas sem alteração dos acessos reais.

## Ownership
- Principal: schema/migração, usuários/auth, consultas de leads/mensagens/entrada, integração e deploy.
- Agente frontend: apenas apps/web.
- Agente segurança: common/access + JwtAuthGuard + websocket; sem editar coleções de negócio.

## Evidence / rulings
- Consulta inicial: quatro contas ativas (Taynara SUPER_ADMIN, Paloma GERENTE, Rúbia e Lívia OPERADOR). Nenhuma nova vendedora cadastrada.
- Vendas/metas PL já filtram seller_id/owner_key para operador. Parceiros atualmente liberado por tenant; leitura/valores precisam ser bloqueados pelo novo perfil.
- Listagem geral inclui leads devolvidos sem dono e detalhes aceitam mesma instância: novo perfil deve ser estritamente responsável atual, mantendo política antiga nos demais.
- Gateway atual distribui por sala do tenant e aceita join:lead sem validação: perfil novo requer isolamento de eventos e verificação de propriedade.

- Migração `20261016200000_pl_sales_only` aplicada atomicamente via DIRECT_URL e registrada com migrate resolve. Quatro contas reais conferidas, zero perfis habilitados, papéis/setores/ativo preservados.
- Verificação com banco real em transação revertida: default false, autenticação lê flag atual, carteira/vendas/metas individuais; acesso a parceiros, terceiros, sem dono e promoção própria negados. Nenhum usuário/lead/venda de teste persistiu.
- Revisão independente: corrigidos retorno de duplicata de telefone fora da carteira (incluindo P2002), credenciais de provedor em instâncias e escolha indevida do número no cadastro. Re-revisão sem pendências.
- Corrigida corrida entre autenticação assíncrona do WebSocket e join imediato; regressão reproduzida antes do fix e teste aprovado depois.
- Typecheck API (1152 MB) e web (1024 MB) aprovados; lint sem erros (avisos legados). Testes web 204/19 suítes pelo executor, recorte independente 45/4 suítes aprovado.
- Notificações de celular, sino e tarefas também consultam responsável atual; dados de conexões restritas limitados a nome/número/status.
- Publicação e smoke HTTP/browser: pendentes.
