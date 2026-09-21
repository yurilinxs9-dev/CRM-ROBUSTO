# Financeiro exclusivo da Paloma

## Identidade e acesso
Tenant `a44772ed-1382-4400-84fc-3fa350e23e42` (Taynara's workspace). Usuária `4f72be61-f5a6-4222-bbfd-074c4da31b87` (Paloma Gomes, palomagomeslobato@gmail.com). O ID apresentado inicialmente como tenant era o ID da usuária; identidade confirmada no banco.

Todas as rotas exigem sessão CRM da Paloma, conta ativa e esses dois IDs. Rotas de dados exigem também sessão financeira própria de duas horas, token opaco guardado somente na memória do navegador, hash no banco e header X-Finance-Session. Outros usuários, admins e impersonação são bloqueados. Menu e busca de navegação seguem o mesmo critério. Dados financeiros não são enviados em websocket do tenant nem guardados em caches do frontend. Credencial inicial ou recuperação exige senha atual do CRM; Paloma escolhe a senha financeira, bcrypt 12. Bloqueio de tentativas, revogação em reset/logout e auditoria de acesso.

## Origem e regra confirmadas
Importar PartnerDailyProduction (vendas reais por parceiro/data); cada registro representa um total diário, não uma venda individual. Importação idempotente ao abrir/atualizar o financeiro e a cada minuto enquanto estiver aberto. A Paloma também pode registrar vendas manuais, com descrição, valor e fechamento; elas não alteram a área Parceiros. Aviso explícito evita relançar vendas já importadas.

Regra inicial: 0,50% do valor vendido, em cinco meses consecutivos, distribuição 0,20 / 0,10 / 0,10 / 0,05 / 0,05%. Último dia de cada mês, começando no mês do fechamento. A Paloma pode ajustar o vencimento individual. Distribuição calculada em centavos com método dos maiores restos, garantindo soma exata da comissão arredondada e valores não negativos.

Regra editável exclusivamente pela Paloma, armazenada em versões. Alterações valem só para vendas novas, sem reescrever parcelas existentes. Somatório da distribuição deve ser igual ao percentual total. API permite 1–12 parcelas para mudanças futuras; padrão inicial sempre cinco.

## Persistência
- FinanceAccess: credencial, versão, contagem de falhas e bloqueio.
- FinanceSession: hash, identidade, versão da credencial, expiração e revogação.
- FinanceRule: versões imutáveis da regra por tenant.
- FinanceSale: origem única, snapshot do valor/fechamento, regra usada, total da comissão, versão, conciliação e cancelamento.
- FinanceInstallment: número, percentual, valor, vencimento ajustável, recebimento manual e versão; vínculo composto por tenant/venda.
- FinanceAudit: antes/depois, autor, ação e horário.
SQL somente para seis novas tabelas com RLS e constraints fixas de tenant/usuária. Nenhuma tabela antiga alterada; migration aplicada atomicamente e registrada em 21/09/2026. Não usar migrate deploy ou db push.

## Alterações e recebimentos
Recebimento marcado somente pela Paloma, com data real. Reversão explícita e auditada corrige erros. Atraso = pendente com vencimento anterior a hoje em São Paulo. Mudanças na origem sinalizam conciliação e mostram valor/data anteriores e novos; aceitar exige que a versão da fonte não tenha mudado desde a conferência. Não recalcular venda com recebimentos. Ajustes manuais de datas são mantidos na conciliação. Venda importada zerada, quando conciliada sem recebimentos, sai da projeção. Cancelar vendas manuais mantém histórico e exige ausência de recebimentos. Versões e transações serializáveis protegem concorrência.

## Interface
Sidebar Financeiro -> acesso separado -> Visão geral, Calendário, Parcelas, Vendas, Histórico de alterações. Projeção de 3/5/6/12/24 meses; comparação previsto por vencimento vs realizado por data real; quitação das parcelas previstas apresentada separadamente. Histórico paginado, filtro por mês, venda e status. Vendas permitem registrar/editar/cancelar manuais, conferir alteração de importadas e navegar às parcelas. Regra de comissão acessível dentro do financeiro. Diálogo de parcela permite ajustar vencimento, marcar recebido e desfazer marcação com confirmação.

## Implementação e validação
Ordem: modelos e SQL, domínio/cálculo, autenticação/serviço/guard/API, frontend, verificação e publicação. Implementação direta nesta tarefa conforme preferência por processo essencial, sem subagentes.
20 testes focados da API e 2 de visibilidade, typechecks, lint e builds. Script `apps/api/scripts/verify-paloma-finance.cjs` verifica importação repetida, exemplo de R$ 20 milhões, regras versionadas, ajuste de datas, recebimento, reversão, cancelamento e sessões em uma transação obrigatoriamente desfeita. Checagens de acesso HTTP em produção sem credenciais financeiras da usuária e sem receber parcelas reais.

## Exceção autorizada para Yuri
O titular da plataforma (user_id 6b854bc0-c935-45a1-b0b4-5a333703dc73) pode abrir e operar o financeiro diretamente ao usar ver como Paloma. Cada requisição valida a assinatura do JWT, o impersonatedBy exato, conta ativa, is_platform_admin e escopo *. Demais administradores seguem bloqueados. O menu considera a conta de origem; a API confirma a permissão antes de abrir. Senha e sessões da Paloma permanecem exclusivas dela. A auditoria registra actor_user_id e acting_as_user_id no snapshot das operações do titular.
