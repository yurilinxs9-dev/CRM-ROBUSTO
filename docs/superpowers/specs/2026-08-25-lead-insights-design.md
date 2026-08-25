# Ficha inteligente do lead + Radar comercial — Design

Origem: proposta Ciafal×JG (`Proposta_CRM_Ciafal_JG`). Trazer o núcleo da "visão 360 com IA" para o CRM-ROBUSTO usando LLM local grátis na VPS. Decisões do Yuri (2026-08-25): motor Ollama 3B na VPS; primeira tela é o painel lateral do chat; MVP completo (resumo, memória, próxima ação, msg sugerida) + central de avisos ("Radar") para o comercial consultar quem chamar.

## Restrições de infra (medidas em 2026-08-25)

VPS: 7.8GB RAM (4.0 disponíveis), **2 vCPUs**, Evolution consome ~1.4GB. Logo:
- Modelo: `qwen2.5:3b-instruct` quantizado q4 (~2.2GB RAM) via **Ollama** em container, `mem_limit: 3g`, CPU-only (~3-6 tok/s).
- **Nada de IA em tempo real**: toda geração roda em fila BullMQ com `concurrency: 1` (um job de LLM por vez, nunca disputando CPU com rajada de webhooks).
- Contexto limitado: prompt recebe no máximo as últimas ~40 mensagens da conversa (mais o insight anterior como memória acumulada), `num_ctx` 4096.

## Motor de IA — reuso do módulo `ai/`

Ollama expõe API OpenAI-compatible (`/v1`). O módulo `ai/` já tem adapter `openai_compatible` com modelos platform-scoped cadastrados pelo super admin. **Zero adapter novo**: cadastrar em `/admin/ai` um modelo `qwen2.5:3b` com base_url `http://ollama:11434/v1` e chave dummy. O worker de insights usa `AiProviderService.chat()` com o modelo configurado para a plataforma (novo campo de config: modelo padrão para insights, platform-scoped — reusar o padrão do agente de IA existente se houver).

Validação do base_url interno: o guard de base_url do módulo ai/ (allowlist) precisa aceitar `http://ollama:11434` — conferir `ai-dto-base-url.spec.ts` e abrir exceção explícita para o host interno `ollama` (só ele, não qualquer http).

## Modelo de dados — `LeadInsight` (tabela nova, SQL manual)

```
LeadInsight {
  id uuid PK
  tenant_id uuid (índice, FK lógica)
  lead_id uuid UNIQUE
  resumo TEXT                    -- resumo da conversa até aqui, pt-BR, 2-4 frases
  memoria JSONB DEFAULT '[]'     -- fatos do relacionamento: [{ fato, quando_dito }]
  proxima_acao_at TIMESTAMPTZ    -- quando chamar de novo
  proxima_acao_motivo TEXT       -- justificativa curta
  msg_sugerida TEXT              -- mensagem pronta de retomada/abertura
  ultima_msg_processada_at TIMESTAMPTZ  -- watermark de geração
  geracoes INT DEFAULT 0
  updated_at / created_at
}
```

Migration: `apps/api/prisma/manual/` + runbook node+Prisma no container (padrão das entregas anteriores). NUNCA `prisma migrate deploy`.

## Pipeline de geração (BullMQ)

1. **Gatilho:** ao processar mensagem inbound, se o lead tem ≥5 mensagens novas desde `ultima_msg_processada_at` OU passou ≥12h com pelo menos 1 nova → enfileira `lead-insight` (dedupe por lead_id, delay 2min para agrupar rajada).
2. **Worker (`concurrency: 1`):** monta prompt com: dados do lead (nome, etapa, temperatura, valor, ultima_interacao), insight anterior (resumo+memória — memória é ACUMULATIVA, nunca descartada, só mesclada), últimas ~40 mensagens. Pede **JSON estrito**: `{ resumo, memoria_novos_fatos[], proxima_acao_em_dias, proxima_acao_motivo, msg_sugerida }`.
3. **Sanitização:** parse defensivo (JSON pode vir sujo de modelo 3B — extrair primeiro bloco `{...}`, validar campos, truncar tamanhos, clamp de dias 1..30). Falha de parse → retry 1x com prompt de correção; falha de novo → mantém insight anterior e loga.
4. `proxima_acao_at = now + proxima_acao_em_dias` (respeitando janela de disparo do tenant se existir configurada).
5. Cron diário de varredura (ex. 03:00 UTC): leads com conversa ativa e insight mais velho que 7 dias → re-enfileira (mantém fichas frescas sem depender de inbound).

## API

- `GET /api/leads/:id/insight` — insight atual (ou 404 limpo; front mostra "ainda não gerado").
- `POST /api/leads/:id/insight/refresh` — enfileira regeneração manual (rate limit: 1 por lead por 5min).
- `GET /api/insights/radar` — a central de avisos. Lista priorizada do tenant (escopo de visibilidade do usuário aplicado — OPERADOR vê os dele):
  1. **Chamar hoje:** `proxima_acao_at <= now` (ordenado por mais atrasado)
  2. **Promissores:** temperatura QUENTE/MUITO_QUENTE sem interação há ≥2 dias
  3. **Esfriando:** sem interação há ≥7 dias com etapa ativa (não ganho/perdido)
  Cada item: lead, motivo (do insight ou derivado), msg_sugerida, link para /chat/:id.

## Frontend

1. **Painel lateral do chat** — card "Inteligência" no drawer/sidebar de detalhes da conversa: resumo, memória (chips/lista), última interação (campo já existente), próxima ação (data + motivo), msg sugerida com botões **"Usar" (joga no composer)** e "Regenerar". Estado "gerando…" quando job na fila.
2. **Radar** (`/radar`) — item novo na navegação (entra em NAV_ITEMS → palette ganha de graça): três seções acima, cards com nome, motivo, tempo desde último contato, msg sugerida (copiar/usar), botão "Abrir conversa". KPI simples no topo (quantos para hoje).
3. Aviso de contagem no sino existente? NÃO no MVP (announcements é outra máquina) — fora de escopo.

## Fora de escopo (registrado)

- Transcrição de ligações/VoIP, integração SAP, ICPs, notas de atendimento por IA (rodadas futuras da proposta).
- IA respondendo cliente diretamente (a IA nunca fala com o cliente).
- Momento de compra por histórico de pedidos (CRM não tem dados de compra; o "ritmo" aqui é conversacional).

## Deploy

Ordem: (1) container Ollama no compose + pull do modelo (~2GB disco), (2) migration SQL, (3) backend, (4) front (Vercel). Reservar: verificar RAM pós-subida (Evolution + Ollama juntos) antes de ligar o cron.

## Verificação

- Testes de unidade: sanitizador do JSON do modelo (o ponto frágil), builder de prompt (truncagem/watermark), query do radar (escopo de visibilidade).
- E2E manual: conversa real → job roda → ficha aparece no chat; radar lista o lead na seção certa; "Usar" preenche o composer.
