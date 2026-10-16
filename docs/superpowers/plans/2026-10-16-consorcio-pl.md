# Consórcio PL e vendas próprias — Implementation Plan

> **For agentic workers:** executar inline com superpowers:executing-plans; revisão independente ao final.

**Goal:** tenant a44772ed-1382-4400-84fc-3fa350e23e42 com funil Consórcio PL, distribuição humana e Vendas da PL/metas sem regressão nos parceiros.
**Architecture:** funil fixo exclusivo, identificação de mensagem no worker existente, vendas individuais e metas em tabelas aditivas. Aba dentro de Parceiros com caches/API próprios. Não tocar no site nem integrar com financeiro.
**Tech Stack:** NestJS/Prisma/PostgreSQL, Next.js/React Query, testes Jest em série.
**Spec:** acordo nesta conversa em 16/10/2026: Paloma dona/GERENTE, Taynara SUPER_ADMIN operacional, Lívia administrativa, Rúbia parceiros, novas vendedoras recebem leads manualmente.

## Global Constraints
- Manter tenant, regras, dados, metas e produção atuais dos parceiros. Não migrar leads antigos nem renomear funil Padrão.
- Criar funil Consórcio PL: Novo, Em atendimento, Simulação enviada, Negociação, Contrato fechado, Perdido. IDs estáveis. Novo sem responsável, sem rodízio; reenvio não redefine responsável/etapa.
- Marcador normalizado Nova Simulação de Consórcio; aproveitar texto recebido como histórico e dados da simulação. IA conservadora para intenção sem marcador, sem classificação de elegibilidade ou atribuição de vendedor. Falha IA não perde mensagem nem altera parceiros existentes.
- Separar identidade por pipeline; não mover parceiro quando mesmo telefone comprar. Respostas seguintes na mesma instância seguem conversa mais recente. Dedupe de mensagens permanece.
- Metas mensais em crédito vendido (R$), geral e por vendedora; nenhum valor inicial. Venda individual com cliente/lead, contrato, valor, data, vendedora e observação; correção versionada e cancelamento auditado, sem exclusão. Snapshot da vendedora preserva autoria histórica.
- Administração por GERENTE/SUPER_ADMIN; operador registra/vê vendas próprias; metas/cancelamentos/correções de equipe por gestores. Excluir Administrativo da seleção de vendedoras, sem alterar papéis atuais.
- Nada de migrate deploy/db push. SQL só objetos novos, transação e direct URL, RLS; idempotência de provisionamento.
- Não carregar mensagens inteiras em memória nem fazer build local pesado (RAM livre ~1,8GB).

## Review Focus
- Outro tenant não acessa API/menus nem é roteado; testes tenant errado.
- Mensagens duplicadas/saídas/respostas não atribuem ao dono do número nem voltam ao funil parceiro.
- Distribuição transfere a conversa e o histórico ao responsável sem mudar configuração global.
- Dinheiro exato, metas ausentes, cancelamentos fora dos totais, versões conflitantes e contrato duplicado.
- Nenhum consumo de produção própria pelo financeiro de parceiros; nenhuma venda automática pela troca de etapa.

## Tasks
- [x] 1. Domínio/testes: normalização, parser simulador, escopo/mensagens IA; modelos PLSale/PLMonthlyGoal/PLSalesAudit e SQL aditivo.
- [x] 2. Serviço/controlador PL: resumo mensal, consulta de candidatos, CRUD versionado, metas, auditoria e bloqueio cross-tenant; testes transação/validação.
- [x] 3. Roteamento webhook/prompt e distribuição manual: preservar conversas, contexto do novo funil e histórico. Testes inbound/regressão de parceiros.
- [x] 4. Interface Vendas da PL: resumo, ranking, formulário de venda, metas geral/individual, edição/cancelamento/histórico; link ao funil e testes de dados.
- [ ] 5. Verificações: Prisma validate/generate, Jest serial, tsc, lint focado, revisão. Aplicar SQL aditivo/provisionar funil, deploy API/web, health e smoke de acesso sem criar dados comerciais falsos.

## Ledger
- A autorização de implementar no tenant foi explícita. Configuração e publicação necessárias fazem parte da entrega; seguir sem solicitar autorização repetida.
- Não alterar configurações de pool/setores/usuários. Metas são crédito vendido, não comissões. Entrada sem classificação confiável mantém fluxo existente para revisão humana.

## Validation checkpoint
- Backend e frontend: TypeScript sem erros (limites 1152/1024MB).
- 184 testes em 12 suites passaram, incluindo parceiros, webhook, distribuição e envio. Jest em série/transpilação isolada; tipagem verificada separadamente. Lint focado sem erros.
- Dry-run: 205 leads no funil Padrão, 40 parceiros, 36 produções (R$36.420.000), 2 metas existentes. Nenhuma tabela PL ainda. WhatsApp leads com status refused/telefone null; precisa reconectar o número 5537988411433 do simulador.
- UI implementada por agente independente e conferida; revisão final independente em andamento.

- Revisão independente: cinco achados corrigidos (syncChat, etapas por funil, retry de origem, timestamps de histórico, gestão exclusiva); segunda revisão sem bloqueios. Histórico ambíguo não é importado em um funil sem evidência.
- 201 testes API + 12 web passaram; typecheck API/web sem erros. Lint sem erros (aviso preexistente no chat).
- SQL e provisionamento aplicados atomicamente. Padrão continua com205 leads/8etapas; parceiros40/produções36/total36420000/metas2 inalterados. Novo funil tem6 etapas/0leads. RLS nas3tabelas.
