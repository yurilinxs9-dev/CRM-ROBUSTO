# Plano — Integração de IA nativa no CRM

## Objetivo
Adicionar IA nativa ao CRM com:
1. **Copilot interno** do atendente (chat lateral: resumo do lead, análise, perguntas).
2. **Sugerir resposta** ao cliente (IA gera rascunho no composer; humano aprova/envia).
3. **Auto-resposta** ao cliente no WhatsApp (`sender_type='ai'`, respeita `ai_blocked`).
4. **Motor de follow-up por IA** (peça essencial): disparo por etapa/segmento, mensagens
   personalizadas por IA, com throttle (ex.: 5 min por mensagem).
5. **Painel super-admin**: seletor de modelo + cadastrar **qualquer** modelo.

## Decisões fechadas
- Config de modelo/chave: **só platform (super admin)**. Não há config por-tenant agora.
- Provedores: **agnóstico** (cliente decide depois). Por isso adapter genérico
  **OpenAI-compatible** (cobre OpenAI, OpenRouter, Groq, local/Ollama, qualquer
  endpoint com `base_url` + `model_id` livre) **+ Anthropic**. Isso satisfaz
  "colocar o que eu quiser de modelo": via `base_url`/`model_id` livre o super admin
  pluga qualquer modelo sem deploy.

## Arquitetura

### Provider abstraction
- Interface `AiProvider.chat(messages, opts) -> { text, usage }`.
- Adapters: `OpenAiCompatibleAdapter` (base_url + model_id), `AnthropicAdapter`.
- Seleção por `AiModelConfig.provider`.

### Schema (Prisma) — novos modelos (platform-scoped)
- `AiModelConfig`: id, label, provider(`openai_compatible|anthropic`), base_url?,
  model_id (string livre), api_key_enc (cifrada), temperature, max_tokens,
  active, is_default, created_by, timestamps.
- `AiAgentConfig`: system_prompt, persona, flags por capacidade
  (copilot/suggest/autoreply/followup), default_model_id.
- `AiUsageLog`: tenant_id, model_config_id, feature, tokens_in, tokens_out,
  est_cost, lead_id?, created_at  → tracking de custo (melhoria).
- `Broadcast`: tenant_id, stage_id?, segment(Json filtro), mode(`template|ai`),
  template?, ai_instruction?, throttle_seconds(default 300), status, created_by.
- `BroadcastTarget`: broadcast_id, lead_id, status(pending/sent/failed/skipped),
  scheduled_at, sent_at, error?.
- Extensão `Stage.cadence_config.steps[]`: + `ai_generate:boolean`,
  `ai_instruction:string` (step de cadência gerado por IA).

### Backend — módulo `apps/api/src/modules/ai/`
- `ai.module.ts`
- `ai-provider.service.ts` (dispatch adapters + cifra AES-256-GCM via `AI_ENCRYPTION_KEY`)
- `ai-config.service.ts` + `ai-config.controller.ts` → `/ai/models` (guard platform-admin)
- `ai-chat.service.ts` + controller → `/ai/copilot`, `/ai/suggest-reply` (monta contexto do lead)
- `ai.dto.ts` (Zod)
- Encryption util; chaves nunca retornam ao client (mascaradas).

### Broadcast / follow-up engine (essencial)
- Fila BullMQ `broadcast` + `broadcast.processor`: dispara 1 msg por janela de
  `throttle_seconds` por instância; respeita `ai_blocked`, safety_lock e opt-out.
- Modo `ai`: gera msg personalizada por lead a partir de `ai_instruction` + contexto.
- Scheduler enfileira targets vencidos. Reusa `messages.sendText(senderType:'ai'|'system')`.
- Integra com `AutomationService.processCadences` (step com `ai_generate`).

### Frontend (Next.js)
- `/admin/ai` (super admin): CRUD de modelos, seletor de modelo, system prompt,
  toggles de capacidade. Componente reusável `<ModelSelect/>` alimentado por `/ai/models`.
- Chat: aba **Assistente IA** (copilot) no painel lateral + botão **Sugerir resposta**
  no `chat-composer` (preenche rascunho, não envia).
- Follow-up: tela de Broadcast (escolher etapa/segmento, instrução IA, throttle,
  preview, lançar, progresso ao vivo via WS).

### Segurança / custo
- Guard `is_platform_admin` no CRUD de modelos.
- Chaves cifradas em repouso; resposta mascarada.
- `AiUsageLog` p/ custo + base p/ rate-limit por tenant.
- Auto-resposta nunca quebra `ai_blocked` (humano assumiu = IA cala).

## Melhorias paralelas (rápidas, fora do core IA)
- `apps/api/src/config/` vazio → criar ConfigModule com schema Zod (regra CLAUDE.md).
- `.gitignore` p/ `scripts/diag-*.js` + `relatorio-ordering.md` (ou mover p/ docs).
- Extrair helper de `sender_type`/`ai_blocked` duplicado em sendText/Audio/Media.

## Fases de entrega
- **Fase 1** — schema + módulo `ai` + adapters + CRUD modelos + UI super-admin (seletor + add modelo). [base de tudo]
- **Fase 2** — copilot chat + suggest-reply no composer.
- **Fase 3** — motor de follow-up/broadcast por IA com throttle + UI.
- **Fase 0 (opcional)** — melhorias paralelas acima.

## Notas de implementação
- Antes de codar adapter Anthropic: ler skill `claude-api` (model IDs/params atuais).
- Migrations: SEMPRE `directUrl` (regra do projeto). Deploy backend VPS via tar+scp.
