# Parceiros e produção — workspace da Taynara

Desenho aceito para implementação, 16/09/2026. Exclusiva do workspace `a44772ed-1382-4400-84fc-3fa350e23e42`.

## Contexto confirmado

A operação prospecta empresas para uma rede de parceiros de consórcio. O formulário de aquisição registra tipo de empresa, experiência, estrutura, vendedores e produção mensal declarada. Essa produção declarada serve à qualificação; não é venda efetivamente realizada com a operação.

O funil atual tem Novo, Introdução, Reunião, Cadastro, Sem Perfil e MEI e PJ. Cadastro é a etapa ganha. Na consulta de 16/09 havia zero leads em Cadastro. Taynara é SUPER_ADMIN e Rúbia é OPERADOR.

## Solução recomendada

Nova entrada **Parceiros** com três visões: Resumo, Parceiros cadastrados e Lançamentos. Um cadastro persistente por parceiro, produção realizada por dia e meta por mês. Manter o relacionamento do parceiro com o lead original quando existir, sem mover ou substituir o histórico de atendimento.

Alternativas consideradas: usar apenas campos no lead seria mais rápido, mas perderia histórico diário e permitiria confundir produção declarada com realizada; uma planilha externa manteria dois sistemas para alimentar e conciliar. O módulo dentro do CRM atende ao acompanhamento diário solicitado.

## Fluxo de trabalho

1. A equipe cadastra um parceiro antigo manualmente ou seleciona um lead da etapa Cadastro para vinculá-lo. Vinculação repetida ao mesmo lead é impedida. Nenhum prospect vira parceiro automaticamente pela simples importação do formulário.
2. Cadastro: nome da empresa/parceiro, contato e telefone opcionais, responsável interno, data de cadastro, ativo/inativo e observações. O vínculo ao lead existente é opcional.
3. Em Lançamentos, selecionar parceiro e data e informar o **total produzido naquele dia**, com observação opcional. Há um total por parceiro/data. Ao alterar um total existente, mostrar o valor anterior e deixar explícito que será substituído, não somado.
4. A soma diária gera a produção mensal automaticamente. Não há campo paralelo de total mensal para evitar dupla contagem.
5. Taynara define a meta de cada mês. R$ 15 milhões é apenas o exemplo do pedido; não gravar esse valor como meta real sem definição da equipe.
6. Parceiros inativos deixam de receber novos lançamentos, mas sua produção histórica continua nos relatórios. Reativação permite voltar a lançar.

## Resumo gerencial

- Seletor de mês e identificação da unidade da produção.
- Produção do dia (no mês atual), produção acumulada do mês, meta mensal, percentual atingido e valor restante.
- Dias corridos restantes no mês, incluindo hoje, com esse critério visível.
- Produção diária necessária para alcançar a meta: restante dividido pelos dias disponíveis. Meses encerrados não exibem necessidade diária; meses futuros exibem o planejamento para o mês inteiro.
- Ranking por produção do mês, destacando os três primeiros e mostrando os demais em tabela. Parceiros sem produção ficam visíveis como sem produção registrada, sem preencher o pódio com zeros.
- Gráfico da produção por dia e do acumulado do mês.
- Quantidade de parceiros ativos, com produção registrada e sem produção registrada no mês.
- Meta ausente aparece como **Meta não definida**, sem percentual inventado. Meta superada mostra o excedente e restante zero.
- Ausência de lançamento significa **sem registro**, não prova de que o parceiro não vendeu. Total zero informado explicitamente representa produção zero naquele dia.

## Unidade comercial proposta

A cliente confirmou em mensagem encaminhada pelo usuário: valor de vendas dos parceiros. Usar Vendas dos parceiros (R$), nunca comissão ou receita da Taynara. A meta soma os valores vendidos registrados pela equipe.

## Acesso e isolamento

- Menu, busca de navegação e página disponíveis somente para o workspace solicitado.
- Backend bloqueia todos os endpoints para qualquer outro tenant, mesmo por URL direta. Tenant vem da sessão autenticada, nunca de parâmetro enviado pelo cliente.
- Taynara e gerentes administram parceiros, metas e correções. Rúbia pode consultar a produção do workspace e cadastrar/atualizar os totais diários; a área representa a rede de parceiros compartilhada. VISUALIZADOR somente consulta.
- Registrar autor, data e valores anteriores/novos das alterações de produção e meta. Nenhuma exclusão física de produção pelo fluxo normal; correção preserva auditoria.
- Validar que parceiro, lead e responsável pertencem ao mesmo workspace. Não permitir alterar a associação de um lançamento para outro tenant.

## Implementação técnica proposta

Módulo NestJS de parceiros com validação Zod, autorização por tenant e papel e uso dos componentes visuais já existentes no Next.js. Tabelas aditivas para parceiro, produção diária, meta mensal e auditoria; valores monetários em Decimal com precisão de centavos. Restrição única por tenant/parceiro/data, por tenant/lead vinculado e por tenant/mês da meta. Data comercial sem horário; limites do mês calculados em America/Sao_Paulo.

Controle de versão na alteração do total diário para impedir que duas pessoas sobrescrevam os valores uma da outra silenciosamente. Resumo calculado a partir dos lançamentos, sem totais financeiros duplicados no lead. Consultas e cache separados por workspace e mês.

O banco possui migrations antigas inconsistentes: aplicar somente SQL dos objetos novos e registrar a migration conforme a regra do repositório. Não executar migrate deploy nem db push. Preservar as alterações locais já existentes em manifest.json e layout.tsx. Rollback desativa o módulo e mantém os novos registros para recuperação.

## Verificação antes de disponibilizar

Testar bloqueio de outros tenants, vínculo a registros de outro workspace, permissões, submissão repetida, conflito de edição, soma por mês, centavos, transição de mês, fevereiro/ano bissexto, metas ausentes/atingidas/superadas e parceiros inativos com histórico. Conferir navegação em desktop e celular, formulário, resumo e acesso direto. Dados de teste ficam fora da produção. Só declarar a funcionalidade disponível após aplicar a migration, publicar backend/frontend e verificar o acesso no workspace correto.

