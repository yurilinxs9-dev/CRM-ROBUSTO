# Atribuição de origem do lead (pago × orgânico)

**Data:** 2026-08-17
**Status:** implementado; migration pendente de aplicação em produção

## Problema

O CRM já mostra o card do anúncio na conversa quando o lead vem de Click to
WhatsApp (ver `anuncio-na-conversa.md`), mas isso é por mensagem e só serve para
o atendente olhar. Não existe nenhuma forma de responder as perguntas que
mandam no orçamento de marketing:

- quanto dos leads vem de tráfego pago e quanto vem de orgânico?
- qual campanha traz lead que fecha, e qual traz volume que não converte?
- o problema é a comunicação do orgânico ou a otimização do pago?

Hoje a única marcação existente é uma tag fixa (`JG - TRAFEGO PAGO`) e um campo
`dados_custom.anuncio` que o próprio lead preenche no formulário. Nenhum dos
dois é confiável nem agregável.

## Decisão central: sem API de plataforma de anúncios

A alternativa óbvia seria conectar a Google Ads API e a Meta Marketing API. Foi
descartada para a v1, e a razão importa:

| | Com API | Como foi feito |
| --- | --- | --- |
| Credencial por tenant | OAuth ou token, cifrado, expira | **Nenhuma** |
| Aprovação da plataforma | Developer token + verificação de app | **Nenhuma** |
| Ação do cliente no CRM | conectar conta | **Nenhuma** |
| Configuração | conta de anúncios vinculada | 2 colagens, 1 vez |

O que se perde sem API: **custo, CPL e ROAS**, e o nome canônico da campanha.
O que **não** se perde: canal, campanha, grupo, criativo, palavra-chave e tipo
de correspondência — porque tudo isso viaja na URL do clique.

Assimetria entre as duas plataformas, que explica o desenho:

- **Meta** empurra o anúncio para dentro do payload do WhatsApp. Chega ID **e
  título** do anúncio sem ninguém configurar nada. Por isso o relatório de Meta
  nasce legível.
- **Google** não empurra nada. O lead entra pelo site e o único carregador é a
  URL. Daí o modelo de acompanhamento e o snippet.

Para o nome da campanha do Google, o ValueTrack só entrega `{campaignid}`
numérico. Em vez de exigir a API, o ID é a chave e o nome amigável é escrito
uma vez pelo usuário (`AdCampaignLabel`). Renomear a campanha no Google não
quebra o histórico, porque o vínculo nunca dependeu do texto.

## O que o cliente configura

1. **Modelo de acompanhamento** na conta do Google Ads, no nível da conta —
   vale para todas as campanhas, inclusive as futuras:

   ```
   {lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}&matchtype={matchtype}&network={network}&device={device}&gclid={gclid}
   ```

2. **Snippet** no site, antes de `</body>`. Está pronto e já preenchido com o
   token do tenant em Configurações › Rastreamento.

Meta via WhatsApp: nada.

## Modelo de dados

Quatro tabelas novas e um enum novo. **Nenhum ALTER em tabela existente** — a
única FK aponta para `Lead` e mora em `LeadAttribution`, mesmo padrão de
`LeadContact`.

| Tabela | Papel |
| --- | --- |
| `LeadAttribution` | origem do lead, 1:1, first-touch imutável |
| `TrackedClick` | clique capturado no site antes de existir lead |
| `AdCampaignLabel` | nome amigável de campanha (substitui a API) |
| `TenantSiteConfig` | token público do site, por tenant |

`AttributionChannel`: `META_ADS`, `GOOGLE_ADS`, `GOOGLE_ORGANIC`,
`SOCIAL_ORGANIC`, `REFERRAL`, `DIRECT`, `INDICACAO`, `UNKNOWN`. O booleano
`paid` é materializado ao lado do canal porque "pago × orgânico" é a pergunta
mais frequente do relatório.

### First-touch

A unique em `lead_id` é o que garante a regra: o segundo toque falha com P2002
e o erro é o comportamento correto — quem trouxe a pessoa foi o primeiro
clique. Cliente antigo que clica num anúncio novo não reescreve a origem.

### O bucket "não identificado" sai por subtração

`LeadAttribution` só é gravada quando **há evidência** (anúncio, código de
clique ou marcação do site). Uma mensagem comum no WhatsApp não paga INSERT
nenhum. O relatório calcula `não identificado = leads do período − leads com
atribuição`, então o denominador continua correto sem escrever linha inútil.

## Os três caminhos de entrada

| Caminho | Como a origem chega |
| --- | --- |
| Meta CTWA | `metadata.ad_referral`, já extraído pelo ingest |
| Site → WhatsApp | código no texto do wa.me, trocado por `TrackedClick` |
| Site → formulário | campo `attribution` no `POST /v1/users` |

O caminho do wa.me existe porque o WhatsApp não passa referrer: a atribuição
precisa viajar no texto pré-preenchido. O snippet gera um código de 8
caracteres, avisa o CRM por um pixel e acrescenta `(ref: XXXXXXXX)` ao texto.

### Por que pixel `<img>` e não `fetch`

O CORS do `main.ts` só libera o `FRONTEND_URL`, e o snippet roda no site do
cliente — outra origem. Requisição de imagem **não manda header `Origin`**,
então passa pela política atual sem alteração nenhuma. Trocar por `fetch`
exigiria afrouxar o CORS global.

## Componentes

### Backend — `apps/api/src/modules/attribution/`

| Arquivo | Papel |
| --- | --- |
| `attribution-classify.ts` | classificador puro: entrada → canal. Sem Prisma, sem Nest |
| `attribution.types.ts` | schemas Zod dos três caminhos, num contrato só |
| `attribution.service.ts` | gravação, resolução de clique, relatório, poda |
| `attribution.controller.ts` | `/api/attribution/*`, com `JwtAuthGuard` |
| `track.controller.ts` | `/api/track/c`, público, devolve GIF 1×1 |

Ordem das regras do classificador (é a decisão de produto, não detalhe):
evidência forte (click ID, anúncio) → evidência declarada (UTM) → evidência
inferida (referrer).

Endpoints: `GET /attribution/summary`, `GET /attribution/campaigns`,
`POST /attribution/campaign-label`, `GET /attribution/site-token`.

Fica fora do `AnalyticsController` de propósito: um módulo novo não deveria
poder quebrar os oito relatórios que já rodam.

### Pontos de integração (mínimos)

| Arquivo existente | O que mudou |
| --- | --- |
| `inbound-message.service.ts` | 1 guarda (regex puro) + 1 método privado, tudo fora do caminho crítico |
| `public-api.service.ts` | grava a origem quando o corpo traz `attribution` |
| `public-api.dto.ts` | campo `attribution` opcional |
| `app.module.ts`, `webhooks.module.ts`, `public-api.module.ts` | registro do módulo |

`recordFirstTouch` **nunca lança**: é chamada de dentro do pipeline de inbound,
e métrica não pode derrubar atendimento.

### Frontend

- `lib/attribution.ts` — tipos e cores por canal (pago quente, orgânico frio).
- `components/dashboard/attribution-donut.tsx` — donut com % de tráfego pago no
  centro. Busca os próprios dados, então entrar no dashboard custou 1 linha.
- `components/analytics/attribution-section.tsx` — canais, campanhas (com
  renomeação inline) e palavras-chave.
- `settings/components/TrackingTab.tsx` — entrega os dois textos prontos.

## Fora de escopo (v1)

- Custo, CPL e ROAS — exigem a API das plataformas.
- Resolução de `gclid` → campanha via `click_view` da Google Ads API. Vale a
  pena quando houver MCC ligada: dispensa o modelo de acompanhamento e traz o
  nome canônico. O modelo de dados já comporta, só falta o job.
- Filtro por canal no Kanban.
- Multi-touch. É first-touch e ponto.

## Riscos aceitos

- **`wbraid`/`gbraid`**: em tráfego iOS/EEA restrito o Google manda esses no
  lugar do `gclid`. Provam que é pago, mas não identificam a campanha. Por isso
  o snippet captura UTM **e** click ID: a UTM é o fallback. Espere uma fatia
  pequena de "Google Ads sem campanha identificada" — melhor explícito do que
  empurrado para outro canal.
- **Texto pré-preenchido é editável**: quem apagar o `(ref: ...)` antes de
  enviar vira "não identificado". É o teto do canal.
- **Modelo de acompanhamento mal colado** = campanha sem ID. O relatório mostra
  o canal certo (pelo `gclid`) e a campanha vazia.
- **Rótulo de campanha demora até 60s** para aparecer depois de renomeado — é o
  TTL do cache, igual ao dos outros relatórios.

## Aplicar em produção

O `_prisma_migrations` deste Supabase está poluído (ver CLAUDE.md), então
`migrate deploy` e `db push` estão proibidos. A migration é só-de-objetos-novos
e tem aplicador próprio, no molde do `apply-kommo-fields.mjs`.

Roda **na VPS, no diretório do repo** (`/opt/crm-whatsapp`), não dentro do
container: é lá que existem `apps/api/node_modules`, o `prisma/migrations/` e o
`.env`. O `docker-compose.yml` não monta `scripts/` no container.

> ⚠️ O passo 5 do fluxo de deploy em `PROJECT_CONTEXT.md`
> (`npx prisma migrate deploy`) está desatualizado e **deve ser pulado** — falha
> com P3009 por causa das migrations "unfinished". Este script o substitui.

Ordem: aplicar a migration **antes** de subir a imagem nova. O código novo
tolera a ausência das tabelas (tudo é capturado), mas o relatório fica fora do ar
até a migration passar.

```bash
cd /opt/crm-whatsapp/apps/api && set -a && . /opt/crm-whatsapp/.env && set +a && node scripts/apply-attribution.mjs --dry-run
```

```bash
cd /opt/crm-whatsapp/apps/api && set -a && . /opt/crm-whatsapp/.env && set +a && node scripts/apply-attribution.mjs
```

O script recusa qualquer statement que altere tabela existente ou que seja
destrutivo, e confere que `Lead`, `Tenant` e `Message` não mudaram de contagem.

Registrar depois (opcional, higiene — o `prisma` é devDependency, então o `npx`
baixa a CLI na hora):

```bash
cd /opt/crm-whatsapp/apps/api && npx prisma migrate resolve --applied 20260817000000_lead_attribution
```

Alternativa sem terminal: `migration.sql` é SQL válido para colar inteiro no SQL
Editor do Supabase (as linhas `-- @@SPLIT` são comentários). Perde-se só a
conferência automática de contagens.
