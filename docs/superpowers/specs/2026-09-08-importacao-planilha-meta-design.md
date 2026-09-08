# Importação da planilha de leads do Meta Lead Ads — Design

Data: 2026-09-08. Cliente piloto: tenant `a44772ed-1382-4400-84fc-3fa350e23e42`
("Taynara's workspace"). Triadora: Taynara (SUPER_ADMIN). Consultora: Rúbia (OPERADOR).

## Problema

Os leads de tráfego pago do cliente chegam por formulário do Meta Lead Ads e caem numa
planilha do Google Sheets (export padrão do Meta, alimentado pela agência). A triadora
lê a planilha, descarta quem é MEI/pessoa física (a empresa só cadastra ME/LTDA para
cima) e repassa o restante à consultora, que liga manualmente. Hoje nada disso passa
pelo CRM. O pedido: a planilha continua sendo a fonte, mas os leads aparecem no CRM
automaticamente, com tudo que o formulário entregou visível e com a Ficha IA já
analisando o perfil antes do primeiro contato.

Planilha: `https://docs.google.com/spreadsheets/d/1nh4sxh7LHDJYRMEW_r9IC47ebGCTWElmKo7enjPCRQc`.
Pública por link (decisão: manter assim por enquanto; trocar por service account é
uma evolução isolada no fetch). 128 linhas em 08/09/2026, 5 são linhas de teste do Meta.

Colunas (fixas, export do Meta): `id`, `created_time`, `ad_id`, `ad_name`, `adset_id`,
`adset_name`, `campaign_id`, `campaign_name`, `form_id`, `form_name`, `is_organic`,
`platform`, 5 perguntas do formulário (`há_quantos_anos_na_atua_com_vendas_de_consórcio?`,
`possui_estrutura_física?`, `tem_quantos_vendedores?`, `média_de_produção_mensal?`,
`sua_empresa_é_mei_ou_ltda?`), `Email`, `Nome Completo`, `Telefone`, `Cidade`, `estado`,
`lead_status`.

## Decisões aprovadas

1. O CRM lê a planilha direto (cron no backend). Sem n8n, sem webhook do Meta.
2. Importa todos, inclusive MEI e pessoa física. Classificação vira campo custom + tag;
   ninguém é descartado automaticamente.
3. Lead cai na etapa "Novo" do funil, sem dono. A triadora atribui à consultora pelo
   fluxo de responsável que já existe.
4. Importa o histórico inteiro na primeira rodada (123 leads reais).
5. Escopo: só este tenant, configuração por variáveis de ambiente no VPS. Sem tela.
6. Ficha IA passa a gerar para lead sem conversa quando há dados de formulário
   (modo pré-contato), e o prompt recebe os campos do cadastro.

## Arquitetura

### Módulo novo `apps/api/src/modules/sheet-import/`

- `sheet-import.parser.ts` — funções puras, sem Prisma nem HTTP:
  - `parseCsv(text): Record<string,string>[]` (aspas, vírgulas dentro de aspas, CRLF).
  - `normalizePhone(raw): string | null` — remove tudo que não é dígito (o export traz
    `p:+5519997094696`, `p:11945550754`); 10 ou 11 dígitos recebem prefixo `55`;
    12 ou 13 dígitos começando com `55` ficam como estão; qualquer outro tamanho é
    inválido (null). Resultado é o mesmo formato que o inbound do WhatsApp grava em
    `Lead.telefone`, para o dedupe por `telefone_pipeline_scope` funcionar.
  - `classifyCompanyType(raw): 'MEI' | 'ME_LTDA' | 'PESSOA_FISICA' | 'NAO_INFORMADO'` —
    minúsculas sem acento; contém `ltda`, `limitada`, `eireli`, `s/a`, `sa` isolado ou
    `me` isolado => ME_LTDA; contém `mei` => MEI; contém `pessoa f`, `fisica`, `nao tenho`,
    `autonom`, `cpf` => PESSOA_FISICA; resto ("Sim", "Meu", "Outro", vazio) => NAO_INFORMADO.
    Ordem importa: "Mei e LTDA" cai em ME_LTDA (tem empresa limitada).
  - `isTestRow(row)` — nome, telefone ou qualquer resposta contendo `<test lead`, ou
    e-mail `test@meta.com`.
  - `mapRow(row): ImportedLead | { skip: motivo }` — monta nome, telefone, e-mail
    (só se passar num teste de formato simples; senão null), campos custom, tags,
    atribuição e texto da atividade.
- `sheet-import.service.ts` — `@Cron(EVERY_5_MINUTES)` + execução no `onModuleInit`.
  Inerte quando `SHEET_IMPORT_TENANT_ID` ou `SHEET_IMPORT_SHEET_ID` não estão definidos.
  Flag em memória impede rodadas sobrepostas. Passos de uma rodada:
  1. `GET https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv[&gid=<GID>]`
     com timeout de 20 s. Resposta só em memória; nada vai para disco.
  2. SHA-256 do texto. Igual ao hash da rodada anterior (em memória) => encerra sem tocar
     no banco. Após restart do container a primeira rodada sempre processa; o dedupe
     por linha garante que isso não cria nada.
  3. Carrega os `source_row_id` já registrados em `SheetImportRow` para o tenant
     (uma consulta). Linhas com id conhecido e `status = 'ok'` ou `'skipped'` são
     ignoradas; com `status = 'error'` e `attempts < 3` são retentadas.
  4. Para cada linha nova: `mapRow`; linha de teste ou sem telefone válido é registrada
     com `status = 'skipped'` e motivo, para não ser reavaliada toda rodada.
  5. Garante as definições de campo custom e o grupo (idempotente, ver "Campos").
  6. Cria ou anexa o lead (ver "Regras por lead") dentro de uma transação com o registro
     em `SheetImportRow`. Erro numa linha grava `status = 'error'`, `detail`, incrementa
     `attempts` e segue para a próxima.
  7. Fora da transação: emite WebSocket, grava atribuição e enfileira a Ficha IA.
  8. Log resumido por rodada: total de linhas, novas, anexadas, puladas, erros.

### Tabela nova `SheetImportRow`

```prisma
model SheetImportRow {
  id            String   @id @default(uuid())
  tenant_id     String
  source_row_id String            // "l:1464784368803570", id do lead no Meta
  lead_id       String?           // null quando skipped/error
  status        String            // 'ok' | 'skipped' | 'error'
  detail        String?           // motivo do skip ou mensagem do erro
  attempts      Int      @default(1)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  @@unique([tenant_id, source_row_id])
  @@index([tenant_id, status])
}
```

Sem FK para `Lead` ou `Tenant`, de propósito: nenhum ALTER em tabela existente, mesmo
compromisso de `LeadAttribution` e `ApiRequestLog`. Migration aplicada pelo
procedimento manual do CLAUDE.md (SQL só de objeto novo, `migrate resolve --applied`).

### Configuração (env do backend no VPS)

| Variável | Obrigatória | Default |
| --- | --- | --- |
| `SHEET_IMPORT_TENANT_ID` | sim | — |
| `SHEET_IMPORT_SHEET_ID` | sim | — |
| `SHEET_IMPORT_GID` | não | primeira aba |
| `SHEET_IMPORT_PIPELINE_ID` | não | pipeline de menor `ordem` do tenant |
| `SHEET_IMPORT_STAGE_ID` | não | etapa base (`user_id` null) de menor `ordem` do pipeline |

## Regras por lead

**Dedupe em dois níveis.**
- Por linha: `SheetImportRow (tenant_id, source_row_id)` único.
- Por telefone: `findUnique` em `telefone_pipeline_scope` com `lead_scope = tenant_id`.
  Se já existe (a pessoa mandou mensagem antes, ou foi cadastrada à mão): não cria.
  Preenche em `dados_custom` só as chaves que estão vazias, acrescenta e-mail se o lead
  não tem, aplica as tags, grava atividade "Dados do formulário Meta anexados" com o
  texto das respostas, registra a linha com `lead_id` do existente. Não muda etapa,
  dono nem temperatura.

**Lead novo.**
- `nome` = Nome Completo (trim; se vazio, o telefone), `telefone` normalizado,
  `email` (ou null), `origem = IMPORT`, `temperatura = FRIO`, `responsavel_id = null`,
  `lead_scope = tenant_id`, `pipeline_id`/`estagio_id` da configuração,
  `estagio_entered_at = now`, `position = -Date.now()` (topo da coluna, como inbound e API),
  `instancia_whatsapp` = instância do tenant com `ultimo_check` mais recente (`leads`),
  `tags` (Json) espelhando as tags aplicadas, `dados_custom` validado por
  `CustomFieldsService.validateValues`.
- `created_at` fica como `now()`; a data do formulário vai para o campo custom
  `form_data`. Métrica de "novos no dia" reflete a entrada no CRM.
- Atividade `lead_created` com descrição "Importado da planilha de leads (Meta Lead Ads)"
  seguida das respostas em uma linha legível:
  "Tipo de empresa: MEI · Anos com consórcio: 3 anos · Estrutura física: Não ·
  Vendedores: 1 · Produção mensal: 500 mil · Paulínia/SP · Campanha: [LEADS] ... V3".
- Tags: catálogo `Tag` (upsert por `tenant_id + nome`) + `LeadTag` + espelho em
  `Lead.tags`, mesmo mecanismo de `PublicApiService.addTags`. Aplica `MEI` quando a
  classificação é MEI, `Pessoa Física` quando PESSOA_FISICA. ME_LTDA e NAO_INFORMADO
  não recebem tag; o campo custom já carrega a informação.
- WebSocket: `emitLeadCreated(leadId, { pipeline_id, estagio_id }, tenantId)`.
- Atribuição: `AttributionService.recordFirstTouch(leadId, tenantId, input)` com
  `utm_source = platform` (`ig`/`fb`; `meta` quando vazio), `utm_medium = 'paid'`
  (`is_organic = true` => `'organic'`), `utm_campaign = campaign_name`,
  `campaignid`, `adgroupid = adset_id`, `creative = ad_id` (ids sem os prefixos
  `c:`/`as:`/`ag:`). O classificador já leva `utm_source` da Meta com meio pago para
  `META_ADS`; verificar na implementação que `ig`/`fb` estão em `META_SOURCES` e
  acrescentar se não estiverem.

## Campos custom (escopo LEAD, grupo "Formulário Meta")

Criados uma vez por `ensureFieldDefs(tenantId)`, idempotente por `(tenant_id, escopo, key)`.
Nunca sobrescreve definição existente com a mesma chave.

| key | nome | tipo | observação |
| --- | --- | --- | --- |
| `tipo_empresa` | Tipo de empresa | select | opções: MEI, ME/LTDA, Pessoa Física, Não informado |
| `tipo_empresa_resposta` | Resposta original (MEI/LTDA) | text | texto cru do formulário |
| `anos_consorcio` | Anos com consórcio | text | |
| `estrutura_fisica` | Estrutura física | text | |
| `qtd_vendedores` | Quantidade de vendedores | text | |
| `producao_mensal` | Produção mensal | text | |
| `cidade` | Cidade | text | |
| `estado` | Estado | text | |
| `form_data` | Data do formulário | date | `created_time` da linha |

Os tipos são `text` porque o formulário é texto livre ("Apenas eu", "12a18cotas").
Os campos aparecem sem mudança no front: drawer do kanban, sheet do chat e página do
lead já renderizam grupos de campos custom (`lead-fields.tsx` / `FieldGroupList`).

## Ficha IA pré-contato (extensão de `lead-insights`)

Hoje `gerarInsight` retorna sem fazer nada quando o lead não tem mensagens, e o único
gatilho é mensagem inbound. Lead importado para ligação manual nunca teria ficha.

Mudanças:
- `gerarInsight` passa a selecionar também `email`, `empresa`, `origem`, `dados_custom`
  e a atribuição (`campaign_name`, `channel`), mais as definições de campo do tenant
  (para escrever rótulo em vez de chave).
- `InsightContexto.lead` ganha `cadastro: { rotulo: string; valor: string }[]` e
  `origem`. `montarPromptInsight` acrescenta o bloco "## Cadastro e formulário" com uma
  linha por item; omitido quando não há nada. Vale para todo lead, importado ou não.
- Quando `mensagens.length === 0` e `cadastro.length > 0`: modo pré-contato. O prompt
  diz que ainda não houve conversa e pede: resumo do perfil a partir do cadastro,
  aderência ao perfil que a empresa atende (MEI/pessoa física fora do perfil; a
  instrução vem no prompt, não em regra fixa), pontos de atenção, abordagem sugerida
  para a ligação. `msg_sugerida` é a abertura da ligação ou primeira mensagem.
  `proxima_acao_em_dias = 0` ("ligar hoje"). Sem mensagens e sem cadastro, continua
  retornando sem gerar.
- `ultima_msg_processada_at` fica null em geração pré-contato, para a primeira mensagem
  real disparar a ficha normal pelo caminho já existente.
- Importador chama `LeadInsightsService.enfileirarImportado(leadId, tenantId)` (novo
  método público, mesmo `jobId` `lead-<id>`) após criar cada lead novo. Worker é
  `concurrency: 1`; os 123 do backfill entram na fila e saem no ritmo do Ollama.
- Lead anexado a um existente não reenfileira ficha.

## Erros e limites

- Download falhou (rede, 4xx/5xx, timeout): log `warn`, próxima rodada tenta de novo.
  Nada é marcado.
- Planilha voltou a ser privada: o export devolve HTML de login com status 200 ou 302
  para `accounts.google.com`. Detectar: resposta cujo cabeçalho não contém as colunas
  `id` e `Telefone` é tratada como falha de download, com log explícito
  "planilha não está acessível por link público".
- Linha com erro de banco: `status = 'error'`, retentada até 3 vezes, depois fica
  registrada para inspeção manual (`SELECT ... WHERE status = 'error'`).
- Cabeçalho mudou (agência trocou pergunta): o `mapRow` usa as colunas fixas do Meta
  por nome exato e as perguntas por nome também, com fallback por posição relativa
  (entre `platform` e `Email`). Pergunta desconhecida não cai em `dados_custom`
  (não há definição), mas entra no texto da atividade. Nenhuma linha deixa de
  importar por causa de pergunta desconhecida.
- Memória: CSV inteiro em memória durante a rodada (~50 KB hoje, ~400 bytes/linha),
  descartado ao fim. `SheetImportRow` cresce uma linha por lead. Nada em disco.

## Fora de escopo (registrado)

- Tela em Ajustes, botão "sincronizar agora", multi-tenant por configuração.
- Atualizar o lead quando a linha da planilha muda depois de importada.
- Escrever de volta na planilha (coluna "importado").
- Service account do Google (troca isolada dentro do fetch, quando quiserem).
- Inserir o nono dígito em celulares antigos de 8 dígitos (`+554797887666`): fica como
  veio; se a pessoa escrever pelo WhatsApp com o 9, vira um segundo card e a triadora
  mescla. Casos assim são raros no export atual (1 em 123).

## Testes

- `sheet-import.parser.spec.ts`: CSV com aspas e vírgula interna; `normalizePhone` para
  `p:+5519997094696`, `p:11945550754`, `p:+554797887666`, lixo; `classifyCompanyType`
  para "Ltda", "Mei", "MEI", "Pessoa Física", "Sim", "Meu", "Mei e LTDA", "ME", vazio;
  `isTestRow`; `mapRow` completo de uma linha real.
- `sheet-import.service.spec.ts` (Prisma mockado): linha nova cria lead + registro +
  atividade + tags; linha conhecida não toca no banco; telefone existente anexa sem
  criar; hash igual encerra cedo; erro em uma linha não derruba as outras; HTML de
  login é tratado como falha de download.
- `insight-prompt.spec.ts`: bloco de cadastro presente/ausente; modo pré-contato
  quando não há mensagens.
- `lead-insights.service.spec.ts`: lead sem mensagem com cadastro gera; sem cadastro
  não gera.

## Deploy e verificação

1. Migration manual da tabela `SheetImportRow` (procedimento do CLAUDE.md).
2. Envs no `.env` do backend no VPS, restart do container `crm-api`.
3. Primeira rodada no boot: log deve mostrar 128 linhas, 123 novas (ou anexadas, se
   algum telefone já existir), 5 puladas, 0 erros. Conferir no kanban da Taynara:
   coluna Novo com os leads, tags MEI/Pessoa Física, campos do grupo "Formulário Meta"
   no drawer, atividade com as respostas na timeline, origem "Importação" no filtro.
4. Fila `lead-insight` esvaziando; abrir 2 ou 3 fichas e conferir o texto pré-contato.
5. Rodada seguinte (5 min) com hash igual: log "planilha sem mudanças".
