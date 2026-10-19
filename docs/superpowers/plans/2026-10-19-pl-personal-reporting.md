# Dashboard e Analytics individuais da PL

Pedido aprovado nesta conversa: liberar Dashboard e Analytics para o perfil restrito da vendedora PL, mostrando exclusivamente seus leads, vendas, metas e atendimento, inclusive entradas por semana/mês e tempo de resposta do WhatsApp. Conta já criada: Comercial PL, tenant a44772ed-1382-4400-84fc-3fa350e23e42. Distribuição manual e parceiros permanecem como estão.

## Decisões
- Reutilizar telas e contratos existentes. Opt-in `pl_sales_only`; preservar os outros perfis.
- Aplicar isolamento no servidor, incluindo agregações, consultas SQL, caches, filtros adulterados, atividades e nomes de membros. Carteira de Consórcio PL com responsável atual; vendas/metas somente da própria vendedora.
- Não contar respostas de colegas como atendimento da vendedora. Sem amostras, mostrar ausência de dados em vez de inventar resposta zero.
- Não liberar APIs gerais, parceiros, rankings da equipe, gestão de metas ou conexão administrativa de WhatsApp. A conexão pessoal usa o fluxo existente; métricas refletem mensagens registradas no CRM.
- Sem migração ou alteração de dados de clientes. Consultas agregadas e testes seriais com memória limitada. Reutilizar checkout atual; preservar scripts diag-lucas não rastreados.

## Implementação e comprovação
1. Backend Dashboard e política: testes de regressão para carteira própria e caches isolados; corrigir todas as consultas expostas e permitir somente as rotas de relatórios verificadas.
2. Backend Analytics: testar e garantir escopo de leads, funil, conversão, desempenho, resposta, previsão e período, sem dados de parceiros/colegas. Valores de vendas reais usam PLSale; metas individuais usam PLMonthlyGoal quando exibidas.
3. Frontend: liberar rotas/menu, tornar rótulos individuais, esconder componentes e links fora do perfil; usar os dados individuais existentes de vendas/metas. Cobrir restrições com testes.
4. Integrar, executar testes focados e verificações de tipos/lint, revisar isolamento independentemente, publicar backend/frontend com limite de memória e rollback.
5. Verificar conta real em produção: relatórios 200, parceiros e gestão bloqueados, dados compatíveis com carteira própria, acesso dos demais preservado. Não criar leads/vendas fictícias em produção.

## Riscos e limites
- Caches antigos de relatórios precisam de chave distinta para perfil restrito.
- Tempos de atendimento e períodos precisam manter a interpretação de datas e a autoria correta das mensagens.
- Meta ainda não definida deve aparecer como não definida; nenhum valor será inventado.

## Evidências
- Regressões reproduzidas antes da implementação: Dashboard aceitava carteira sem dono e cache amplo; política ainda negava os nove relatórios.
- Dashboard restrito: carteira atual do Consórcio PL, cache desativado, atividades próprias, sem ranking, entradas dos últimos sete dias/mês brasileiro e vendas confirmadas próprias.
- Analytics: oito consultas isoladas, pipeline adulterado não altera o escopo; cálculos de valor estimado identificados separadamente dos contratos reais e meta mensal.
- Tempo de primeira resposta: agregação no banco, fronteiras de atribuição e conversa, mensagens próprias; eco do celular somente quando há comprovação de conexão pessoal exclusiva. Sem amostras não se exibe tempo inventado.
- Suíte API: 1.695 testes / 105 suítes aprovadas, serial, heap 768 MB com transpile isolado. Typecheck API 1152 MB e web 1024 MB aprovados; ESLint dos arquivos alterados sem erros.
- Suíte web: 226 testes / 20 suítes aprovadas, serial, heap 768 MB. Cobertura de cache por conta/perfil, menus, requisições bloqueadas, estados vazios e comportamento anterior da gestão.
- Consultas novas executadas em transação READ ONLY no banco real: Dashboard e oito métodos Analytics aprovados; conta real com zero leads próprios. Nenhum registro de cliente alterado.
- Revisão independente concluída sem bloqueios após duas correções: uma única configuração de etapas por relatório e tempo de resposta iniciado na atribuição quando existe solicitação pendente.
- Após essas correções: 150 testes focados aprovados, Typecheck API e ESLint aprovados; nove consultas reais READ ONLY novamente aprovadas.
- SQL de primeira resposta executado contra 19 cenários em CTEs SELECT-only, sem inserir registros: atribuição, solicitação já respondida, respostas próprias/de colega/IA, mensagens privadas, conexão exclusiva/compartilhada, outros tenants/funis, sem resposta e fronteira de período. Todos aprovados.
- Publicação e verificação HTTP/browser em andamento.
