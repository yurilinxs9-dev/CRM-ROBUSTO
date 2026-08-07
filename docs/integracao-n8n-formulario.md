# Integração n8n — formulário → CRM (substituindo o Kommo)

Documenta como refazer, contra a API pública deste CRM, o fluxo n8n que hoje
joga leads de formulário no Kommo (workflow **NOVO FORMULÁRIO**).

O ponto de partida é o fluxo existente: Google Sheets recebe a resposta do
formulário, o n8n busca o contato no Kommo por telefone, depois por e-mail, cria
o contato se não achar, cria o lead no funil, preenche campos por `field_id`,
aplica a tag `JG - TRAFEGO PAGO` por `id`, e marca a linha da planilha como
`n8n = ok`.

---

## 1. A diferença estrutural: contato **é** lead

No Kommo, contato e lead são entidades separadas — por isso o fluxo tem
`Cria contato1` e depois `cria lead1`, ligando um ao outro por `_embedded.contacts`.

Neste CRM **não existe essa separação**. `POST /api/v1/users` grava direto na
tabela `Lead` (ver `public-api.service.ts` → `createContact`): nome, telefone,
e-mail e tags vão para a mesma linha, que já nasce dentro de um funil.

Consequência prática: **os dois nós viram um só**. O ramo inteiro
`Cria contato1 → Code in JavaScript8 → cria lead1` colapsa numa única chamada.

O nome do endpoint (`/users`) é herança da API pública, que chama de "usuário" o
contato do outro lado da conversa. Não confundir com `User`, que no banco é o
operador do CRM.

---

## 2. Autenticação

```
Authorization: Bearer <api-key>
```

A chave é criada em **Configurações → Chaves de API** e carrega escopos. Para
este fluxo bastam:

| Escopo | Para quê |
| --- | --- |
| `contacts:read` | buscar por telefone/e-mail |
| `contacts:write` | criar o lead |

- Base: `https://<seu-dominio>/api/v1`
- Rate limit: **120 req/min por chave** (janela fixa, Redis). Acima disso, `429`.
- `Idempotency-Key` (header, opcional) em POST/PATCH: repetir a mesma chave
  devolve a resposta guardada em vez de criar de novo. **Use.** Um fluxo que
  roda a cada minuto sobre uma planilha vai reprocessar linha; ver §6.

---

## 3. Equivalência, nó a nó

| n8n hoje (Kommo) | No CRM | Situação |
| --- | --- | --- |
| `Google Sheets Trigger1` + `Filter1` | igual, não muda | ✅ |
| `busca lead cell1` — `GET /api/v4/contacts?query=<telefone>` | `GET /api/v1/users?phone=<telefone>` | ✅ |
| `Telefone?1` (achou?) | igual, sobre `data.length` | ✅ |
| `busca lead email1` — `?query=<email>` | `GET /api/v1/users?email=<email>` | ✅ |
| `Email?1` | igual | ✅ |
| `Cria contato1` + `cria lead1` | **um** `POST /api/v1/users` | ✅ simplifica |
| `Code in JavaScript6/7/8` | desnecessários | ✅ somem |
| Tag por `{"id": 7618}` | `"tags": ["JG - TRAFEGO PAGO"]` — **por nome** | ✅ |
| `pipeline_id` / `status_id` por ID | **sem equivalente** | ❌ §5 |
| `custom_fields_values` por `field_id` | `dados_custom` por **chave** | ✅ §5.2 |
| `Append or update row in sheet1` (`n8n=ok`) | igual, não muda | ✅ |
| `Wait1` (3s) | ver §6 | ⚠️ |

---

## 4. As chamadas

### 4.1 Buscar por telefone

```
GET /api/v1/users?phone=5531999999999
Authorization: Bearer <api-key>
```

O backend tira tudo que não é dígito e faz `contains` sobre `Lead.telefone`.
Então `(31) 99999-9999`, `+55 31 99999-9999` e `5531999999999` chegam no mesmo
lugar — não precisa normalizar no n8n.

Resposta:

```json
{
  "data": [ { "id": "uuid", "name": "...", "phone": "...", "email": "...", "tags": [] } ],
  "pagination": { "total": 1, "limit": 50, "offset": 0 }
}
```

Achou = `data.length > 0`. Diferente do Kommo, que devolve `_embedded.contacts`
e exige `JSON.parse` — daqui vem JSON já estruturado, e os três nós
`Code in JavaScript` deixam de ter função.

### 4.2 Buscar por e-mail

```
GET /api/v1/users?email=fulano@dominio.com
```

Atenção: e-mail é **igualdade exata**, telefone é `contains`. Um e-mail com
maiúscula diferente do que está gravado não casa.

### 4.3 Criar o lead

```
POST /api/v1/users
Authorization: Bearer <api-key>
Idempotency-Key: <Phone number da linha da planilha>
Content-Type: application/json

{
  "name":  "{{ $('trata dados1').item.json['Full name'] }}",
  "phone": "{{ $('trata dados1').item.json['Phone number'] }}",
  "email": "{{ $('trata dados1').item.json.Email }}",
  "tags":  ["JG - TRAFEGO PAGO"]
}
```

Limites do schema (Zod, `createContactSchema`): `name` 1–200, `phone` 8–30,
`email` precisa ser e-mail válido **ou ser omitido** — mandar `""` dá `400`. Se a
planilha pode vir sem e-mail, omita a chave em vez de mandar vazia. `tags`: até
20, cada uma até 50 caracteres.

O lead nasce com `origem: "MANUAL"`, sem responsável, na instância de WhatsApp
mais recente do tenant, no **primeiro funil e primeiro estágio** (`ordem` asc).

---

## 5. O que não tem equivalente hoje

Duas coisas do fluxo Kommo **não são reproduzíveis** pela API pública. Não é
questão de sintaxe diferente: o endpoint não aceita.

### 5.1 Escolher funil e estágio

`createContact` resolve o funil sozinho: pega o primeiro do tenant por `ordem` e
o primeiro estágio dele. Não há `pipeline_id`/`status_id` no corpo.

Se o primeiro funil do tenant já for o "Novo Lead", o comportamento bate com o
do fluxo atual por coincidência de ordenação — mas passa a depender de ninguém
reordenar os funis. Vale conferir antes de migrar.

### 5.2 ~~Campos personalizados~~ — resolvido

> Era o bloqueio para migrar. `dados_custom` passou a ser aceito na API pública.

O fluxo Kommo preenche nove campos por `field_id` (481468 nome, 481470 telefone,
481472 cidade, 481480 modelo/ano, 818566 o que busca, 818568 preocupação, 818570
urgência, 597026 e-mail, 818634 anúncio).

Aqui não se usa id numérico: cada campo tem uma **chave** estável (slug), e o
valor vai num objeto `dados_custom`.

**Descobrir as chaves:**

```
GET /api/v1/custom-fields
Authorization: Bearer <api-key>       (escopo contacts:read)
```

```json
{
  "data": [
    { "key": "cidade", "nome": "Cidade", "tipo": "text", "options": null, "api_only": false }
  ]
}
```

**Usar no POST:**

```json
{
  "name": "...", "phone": "...", "email": "...",
  "tags": ["JG - TRAFEGO PAGO"],
  "dados_custom": {
    "cidade": "{{ $json.City }}",
    "modelo_ano": "{{ $json['Qual o MODELO e ANO do seu veículo?'] }}"
  }
}
```

O valor é validado e convertido contra a definição do campo — a mesma rotina que
a ficha do lead usa (`customFields.validateValues`). Chave que não existe, ou
valor de tipo errado, vira `400` **com o nome do campo**, em vez de entrar cru
no Json e aparecer torto na ficha uma semana depois.

Campos marcados **"Apenas API"** (`api_only`) são graváveis por aqui e bloqueados
na UI — é exatamente o caso de uso do badge.

`PATCH /api/v1/users/:id` também aceita `dados_custom`, e **mescla** com o que já
está gravado: mandar só `{"modelo_ano": "..."}` não apaga `cidade`.

---

## 5.3 Reincidência — a mesma pessoa preenche o formulário duas vezes

**É o caso que mais muda entre os dois sistemas, e o que motivava a busca prévia
do fluxo original.** Quem vê o anúncio duas vezes preenche duas vezes.

No Kommo: contato e lead são separados, então a segunda submissão **reaproveita o
contato e cria um lead novo** — duas negociações, mesma pessoa. Era exatamente
por isso que o fluxo tinha `busca lead` antes de `Cria contato`.

Aqui isso **não é possível**, e não por falta de endpoint:

```
@@unique([telefone, pipeline_id, lead_scope], name: "telefone_pipeline_scope")
```

Um lead por telefone, por funil, por tenant. Um `POST /v1/users` repetido volta
`409 Conflict — "Recurso já existe."`.

Também não é acidente: `leads.service.create` devolve o lead existente com
`already_existed: true` em vez de falhar, com a decisão registrada no código —
*"quem digita um telefone que já existe quase sempre quer falar com aquela
pessoa, não criar um segundo registro"*.

**O desenho equivalente aqui** é manter um card por pessoa e devolvê-lo ao topo
do funil, com a passagem anotada:

```
achou o lead
  → PATCH /v1/users/:id          (dados_custom com as respostas novas + tags)
  → POST  /v1/users/:id/stage    { "stage_id": "<Novo Lead>" }
  → POST  /v1/users/:id/activities
         { "tipo": "form_resubmit",
           "descricao": "Preencheu o formulário de novo — anúncio X" }
```

O vendedor vê o card subir de volta para "Novo Lead" com o histórico das duas
passagens no mesmo lugar, em vez de dois cards para a mesma pessoa.

### Descobrir o `stage_id`

```
GET /api/v1/pipelines          (escopo contacts:read)
```

```json
{
  "data": [
    {
      "id": "uuid", "nome": "Funil principal", "ordem": 0,
      "stages": [
        { "id": "uuid", "nome": "Novo", "ordem": 0, "is_won": false, "is_lost": false }
      ]
    }
  ]
}
```

Buscar pelo **nome** do estágio e ler o `id` na hora é melhor que colar o UUID no
nó: id copiado à mão apodrece calado quando alguém reorganiza o funil.

`POST /v1/users/:id/stage` delega para o `updateStage` interno — o mesmo que o
Kanban usa. Então grava a atividade "Movido de X para Y", reseta o tempo no
estágio, dispara as auto-ações do destino e emite o WebSocket que faz o card
andar na tela de quem está com o Kanban aberto. O contador de não-lidas **não**
é zerado: mover por integração não significa que alguém leu a conversa.

---

## 6. Reprocessamento e duplicata

O fluxo atual protege contra duplicata de três jeitos: a coluna `n8n` na
planilha, a busca prévia por telefone/e-mail, e o `Wait1` de 3s entre iterações.

No CRM há uma quarta rede, do lado do servidor: `Lead` tem unique em
`(telefone, pipeline_id, lead_scope)`. Se dois disparos tentarem criar o mesmo
telefone no mesmo funil, o segundo **não** vira erro — `leads.service.create`
devolve o lead existente com `already_existed: true`.

Ainda assim, mande `Idempotency-Key` no POST (o telefone da linha serve). É a
proteção que funciona mesmo quando a busca prévia passa batido por corrida entre
duas execuções do n8n.

Sobre o `Wait1` de 3s: existia para não estourar o rate limit do Kommo. Aqui o
limite é 120 req/min por chave e cada linha consome 2–3 chamadas, ou seja ~40
linhas/min cabem sem espera. Pode reduzir ou remover — mas confira o volume real
do formulário antes.

---

## 7. Segurança

O JSON do workflow atual carrega o **token do Kommo em texto puro**, dentro do nó
`trata dados1` (`Kommo_Token`, JWT com escopo `crm`, expira em 2031). Quem
exportar ou compartilhar o workflow leva o token junto.

Ao migrar, ponha a API key do CRM em **Credentials do n8n**, não num nó `Set`.
E revogue o token do Kommo quando desligar a integração — ele continua válido
até 2031, independente de você parar de usar.

---

## 8. Resumo do desenho novo

```
Google Sheets Trigger → Filter (n8n ≠ ok) → Loop
  → trata dados (sem token no nó — credencial do n8n)
  → GET /api/v1/users?phone=…
      ├─ achou ──────────────┐
      └─ vazio → GET /api/v1/users?email=…
                    ├─ achou ┤
                    │        │  REINCIDÊNCIA (§5.3)
                    │        └→ PATCH /users/:id        (respostas novas)
                    │           POST  /users/:id/stage  (volta pra "Novo Lead")
                    │           POST  /users/:id/activities (anota a passagem)
                    │
                    └─ vazio → POST /api/v1/users   ← contato + lead numa chamada
  → Append or update row (n8n = ok)
```

De 16 nós para ~8. Os três `Code in JavaScript` somem porque a resposta já vem
estruturada, e o par contato/lead vira uma chamada só.

**Antes de migrar, confira duas coisas:**

1. Rode `GET /api/v1/custom-fields` no tenant de destino e confira se as chaves
   dos nove campos do formulário existem. Se algum não existir, crie em
   Configurações → Campos personalizados **antes** de ligar o fluxo.
2. Confira qual é o primeiro funil por `ordem` (§5.1) — é onde o lead vai cair.

Workflow pronto para importar: `docs/n8n/novo-formulario-crm.json`.
