# Anúncio de origem na conversa (Click to WhatsApp)

**Data:** 2026-08-05
**Status:** especificado, não implementado

## Problema

Quando um lead chega por anúncio pago da Meta (Click to WhatsApp), o WhatsApp do
celular mostra, acima da primeira mensagem, um card com a imagem do anúncio, o
título, o texto e o link do post. No CRM esse card não aparece — o atendente vê
apenas a mensagem solta e não sabe de qual criativo o lead veio.

## O que já existe no banco

Levantamento feito em 2026-08-05 direto no Supabase de produção (read-only):

- 780 mensagens `INCOMING` já carregam `externalAdReply` dentro de
  `Message.metadata.raw`, distribuídas em 691 leads e 7 instâncias
  (`agendamento-vania`, `atendimento-marcelo`, `diplapel`, `celular-adm`,
  `atendimento-alex`, `comercial`, `atendimento`), com ocorrências no próprio dia
  da sondagem — ou seja, o dado continua chegando.
- O payload sobrevive ao `stripHeavyRawKeys` (`inbound-message.service.ts:25`),
  que remove apenas `jpegThumbnail`; o campo do anúncio se chama `thumbnail`.

Nada disso é lido hoje: não há nenhuma ocorrência de `referral`, `ctwa`,
`contextInfo` ou `externalAdReply` no código do projeto.

### Onde o objeto fica

Dois caminhos, um por provider:

| Caminho | Provider |
| --- | --- |
| `raw.data.contextInfo.externalAdReply` | Evolution / Baileys |
| `raw.message.content.contextInfo.externalAdReply` | UazAPI |

### Campos observados

`title`, `body`, `sourceApp` (`instagram`, `facebook`), `sourceUrl`, `sourceId`,
`mediaUrl`, `mediaType`, `ctwaClid`, `thumbnail`, `thumbnailUrl`,
`originalImageUrl`, `sourceType`, `showAdAttribution`, `containsAutoReply`.

Duas armadilhas confirmadas na amostra:

1. **Grafia dupla.** As mesmas chaves aparecem em duas capitalizações:
   `sourceUrl`/`sourceURL`, `sourceId`/`sourceID`, `thumbnailUrl`/`thumbnailURL`,
   `originalImageUrl`/`originalImageURL`. A leitura precisa aceitar as duas.
2. **Thumbnail com dois formatos.** Ora vem como byte-map
   (`{"0":255,"1":216,…}`), ora como string base64. O tamanho fica entre 1 KB e
   8 KB — pequeno o bastante para trafegar inline, sem Supabase Storage.

Exemplo real (instância `agendamento-vania`):

```json
{
  "title": "Viva uma formatura inesquecível! ✨",
  "body": "Tudo começa com uma decisão: transformar anos de dedicação…",
  "sourceApp": "instagram",
  "sourceUrl": "https://www.instagram.com/p/DbDxlGxs6jt/",
  "sourceId": "120251874055560237",
  "mediaUrl": "https://www.facebook.com/reel/949065808150815/",
  "ctwaClid": "AfgLBjYZquD6-iob2B4-R1TwVFdSYiK8p-…",
  "mediaType": 2,
  "thumbnail": { "0": 255, "1": 216, "2": 255, "…": "…" }
}
```

## Decisão de arquitetura

**Derivar na leitura, sem tocar no banco.**

Como o payload bruto já está persistido, não é preciso alterar o ingest nem rodar
backfill: basta interpretar o `metadata.raw` no momento em que a mensagem é
servida. Consequências:

- Zero migration. Relevante porque o `_prisma_migrations` deste Supabase está
  poluído e qualquer migration exige o procedimento manual descrito no CLAUDE.md.
- Os 691 leads históricos passam a exibir o card já no primeiro deploy, sem
  script de manutenção rodando em produção.
- O custo de derivação é desprezível: 780 mensagens em 106.648 (0,73%), e a
  função sai cedo quando não há anúncio.

Alternativas descartadas:

- *Extrair no inbound e gravar `metadata.ad` normalizado, com script de backfill
  das 780 linhas.* Mesmo resultado visual, mas com 780 `UPDATE` em produção e sem
  dispensar o código de leitura do formato antigo.
- *Frontend lendo `metadata.raw` direto.* Acopla a interface ao formato de cada
  provider e mantém o payload pesado indo para o navegador.

## Componentes

### 1. `apps/api/src/modules/webhooks/ad-referral.ts` (novo)

Módulo puro, sem dependência de Prisma ou Nest.

```ts
export interface AdReferral {
  title?: string;
  body?: string;
  source_app?: string;
  source_url?: string;
  source_id?: string;
  media_url?: string;
  ctwa_clid?: string;
  thumbnail_data_url?: string;
}

export function extractAdReferral(metadata: unknown): AdReferral | null;
```

Comportamento:

- Tenta os dois caminhos conhecidos. Se nenhum casar, faz uma varredura recursiva
  com profundidade limitada procurando a chave `externalAdReply`, de modo que um
  provider novo funcione sem exigir deploy.
- Lê cada campo aceitando as duas grafias (`sourceUrl ?? sourceURL`, e assim por
  diante).
- Normaliza `thumbnail` de byte-map, array de números ou string base64 para
  base64, reaproveitando a lógica já existente em `asMediaKey`
  (`message-extractor.ts:43`), escrita para exatamente esse par de formatos.
- Valida os magic bytes de JPEG (`FF D8 FF`) antes de montar o data URI. Se a
  validação falhar, descarta a imagem e devolve o restante do card.
- Devolve `null` quando não há anúncio, com verificação barata antes de percorrer
  o objeto.
- Proibido `any` (regra 2 do CLAUDE.md); usar os helpers de narrowing no estilo
  do `message-extractor.ts`.

Testes (`ad-referral.spec.ts`), todos puros:

- payload Evolution real → todos os campos preenchidos;
- payload UazAPI real → todos os campos preenchidos;
- thumbnail byte-map e thumbnail base64 → mesmo data URI;
- chaves em grafia alternativa (`sourceURL`, `sourceID`) → lidas;
- thumbnail com bytes inválidos → card sem imagem, texto preservado;
- mensagem sem anúncio, `metadata` nulo e `metadata` com lixo → `null`.

### 2. `apps/api/src/modules/messages/messages.service.ts`

Em `getHistory` (declarado na linha 920), no mesmo `map` que hoje assina as URLs
de mídia (linha ~977), acrescentar `ad_referral: extractAdReferral(msg.metadata)` e **remover
`metadata`** do objeto devolvido.

A remoção é segura: o único consumidor de `getHistory` é
`messages.controller.ts:100`, e o frontend não lê `metadata` em lugar nenhum. O
efeito colateral é positivo — hoje o histórico do chat carrega o payload bruto
inteiro do provider até o navegador sem que ninguém o use.

### 3. `apps/api/src/modules/webhooks/inbound-message.service.ts`

Na emissão do WebSocket (linha 668), trocar `message` por
`{ ...message, ad_referral }`, para que o card apareça na mensagem que chega em
tempo real e não só depois de recarregar a conversa.

### 4. `apps/web/src/components/chat/types.ts`

Acrescentar a interface `AdReferral` (espelho da do backend) e o campo
`ad_referral?: AdReferral | null` em `ChatMessage`.

### 5. `apps/web/src/components/chat/ad-referral-card.tsx` (novo)

Card renderizado dentro da bolha, acima do conteúdo da mensagem:

- miniatura de ~60 px à esquerda, quando houver `thumbnail_data_url`;
- rótulo `📢 Anúncio · Instagram` (o sufixo vem de `source_app`; sem ele, apenas
  `📢 Anúncio`);
- título em negrito;
- corpo do anúncio truncado em 3 linhas;
- link para `source_url`, com `target="_blank"` e `rel="noopener noreferrer"`,
  seguindo o padrão de `renderText` em `message-bubble.tsx:73`.

O visual segue `reply-preview.tsx` para não introduzir uma linguagem gráfica nova
no chat.

### 6. `apps/web/src/components/chat/message-bubble.tsx`

Renderizar `<AdReferralCard>` antes do conteúdo quando `message.ad_referral`
estiver presente.

## Fora de escopo

- Badge de anúncio na lista de conversas.
- Filtro ou relatório de leads por anúncio.
- Novo valor no enum `LeadOrigem` ou gravação da origem em `Lead`.
- Script de backfill (desnecessário nesta arquitetura).

## Riscos aceitos

- Anúncio sem `sourceApp` exibe o rótulo genérico `📢 Anúncio`.
- Anúncio sem thumbnail exibe o card apenas com texto.
- `sourceUrl` de campanha encerrada pode levar a uma página inexistente no
  Facebook ou Instagram. Não há como detectar isso do nosso lado.
- A varredura recursiva de fallback tem profundidade limitada; um provider que
  aninhe o objeto muito fundo passaria despercebido e exigiria acrescentar o
  caminho explicitamente.
