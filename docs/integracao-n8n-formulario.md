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
| `custom_fields_values` por `field_id` | **sem equivalente** | ❌ §5 |
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

### 5.2 Campos personalizados

O fluxo Kommo preenche nove campos por `field_id` (481468 nome, 481470 telefone,
481472 cidade, 481480 modelo/ano, 818566 o que busca, 818568 preocupação, 818570
urgência, 597026 e-mail, 818634 anúncio).

O CRM tem a estrutura equivalente — `CustomFieldDef` por tenant e
`Lead.dados_custom` — e o Porto Sul já tem 23 campos definidos. **Mas
`createContactSchema` não aceita `dados_custom`**, então hoje esses valores não
têm como entrar pela API pública. Nome, telefone e e-mail entram porque são
colunas próprias; o resto (cidade, modelo/ano, as três perguntas do formulário,
anúncio) se perderia na migração.

**O que faltaria:** aceitar `dados_custom` no `createContactSchema` e passar pelo
`customFields.validateValues` (a mesma validação que `leads.service.create` já
usa), mais um `GET /api/v1/custom-fields` para o n8n descobrir as chaves. É
trabalho pequeno e contido — mas é trabalho, e precisa ser feito **antes** de
desligar o Kommo, senão o formulário passa a chegar sem os dados que o vendedor
usa para atender.

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
      ├─ achou  → segue (lead já existe)
      └─ vazio  → GET /api/v1/users?email=…
                    ├─ achou  → segue
                    └─ vazio  → POST /api/v1/users   ← contato + lead numa chamada
  → Append or update row (n8n = ok)
```

De 16 nós para ~8. Os três `Code in JavaScript` somem porque a resposta já vem
estruturada, e o par contato/lead vira uma chamada só.

**Bloqueio para migrar:** §5.2. Sem `dados_custom` na API pública, as respostas
do formulário não chegam no lead.
