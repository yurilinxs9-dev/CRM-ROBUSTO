# Planilha do Consórcio PL

Importar a planilha `1yMPg7jI7Z62bwdCZjP57crgGNfCKe42XcwduJLxU9xg`, aba 0, exclusivamente no tenant PL e no funil Consórcio PL. Taynara e Paloma acompanham; distribuição manual por Taynara, mantendo as permissões atuais. Vendedoras recebem somente sua carteira.

Reutilizar o motor de importação existente com uma segunda fonte e mapeamento explícito, sem substituir a planilha de parceiros. É preferível a duplicar todo o serviço ou criar outra integração externa. Rodar no início e a cada cinco minutos, com deduplicação independente por fonte.

Os 18 cadastros reais foram comparados em 03/11 com todos os leads do tenant por telefone normalizado, variante de nono dígito e e-mail: nenhuma correspondência. Uma linha de teste será ignorada. Na ativação, repetir a consulta. Novo lead entra em Novo sem responsável. Mesmo telefone no Consórcio complementa apenas campos vazios, preservando responsável, etapa e valores. Correspondências ambíguas ou em outro funil ficam registradas para revisão, sem mover nem duplicar automaticamente.

Grupo Formulário Consórcio: objetivo original (inclui ambos/indeciso), faixas de imóvel/veículo/carta, prazo de contratação, faixa da parcela, disponibilidade de lance, cidade e data. Nome, telefone e e-mail usam campos existentes. Imóvel pode preencher bem de interesse quando vazio; veículo genérico não prova carro/novo/seminovo. Faixas não viram valor exato. Campanha e origem ficam registradas. A ficha IA pode usar respostas sem depender de mensagem de WhatsApp; importação independe da disponibilidade da IA.

Não alterar parceiros, vendas, metas, senhas, distribuição existente nem enviar mensagens. Não modificar a planilha. Sem migração de banco. Exibir o grupo de consórcio somente no funil PL. Validar mapeamento, repetição, acesso e preservação antes de ativar.

## Proteção entre fontes e ativação

Com a nova fonte habilitada, as duas importações desse tenant coordenam consulta e gravação com advisory lock transacional. Correspondência entre os dois funis exige revisão em vez de criar uma segunda ficha. Campos/atribuições de parceiros existentes e configuração da planilha anterior permanecem. Outros tenants mantêm o comportamento anterior. Anexações usam updated_at como controle de concorrência; uma edição intermediária cancela a anexação e permite nova tentativa.

Configuração adicional: PL_SHEET_IMPORT_SHEET_ID e PL_SHEET_IMPORT_GID=0. Tenant e funil são fixados no código. Para suspender só esta fonte, remover o sheet ID adicional e recriar somente o backend. Não executar migrations nem reiniciar serviços de WhatsApp.

Na segunda conferência de 03/11, a planilha passou a conter 19 cadastros reais e uma linha de teste. Os 19 não tinham correspondência nos 282 leads do tenant (39 no Consórcio PL).
