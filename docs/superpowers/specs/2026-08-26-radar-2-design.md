# Radar 2.0 — Central do Dia + Jornada Inteligente — Design Master

Feedback do Yuri (2026-08-26): o Radar v1 (3 listas) é raso e confuso; a ficha 360 automática é o ponto forte. O Radar precisa virar O DIFERENCIAL do CRM: organizado por funil, fácil de buscar, separando etapas/promissores/compradores, com a IA acompanhando a jornada, tomando decisões (temperatura), lembrando compromissos temporais ditos em conversa, análise financeira e ajuda embutida — tudo intuitivo, "fugindo da cara de IA".

## Princípios de UX (valem para todas as fases)

- Linguagem humana, zero jargão de IA ("Fulano está esperando sua resposta há 3 horas", nunca "insight score 0.87").
- Organização por FUNIL: seletor de pipeline no topo do Radar (mesmo padrão do kanban); tudo respeita o funil escolhido + opção "Todos".
- Busca sempre presente (nome/telefone) filtrando as seções ao vivo.
- Toda automação da IA é: explicada (motivo visível), reversível, com histórico e com toggle.
- Ajuda: ícone "?" em cada seção abrindo explicação curta em português simples; central "Como funciona" com tudo.

## FASE 1 — Coração operacional (a dor de hoje)

1. **Fila "Esperando você"** (topo, destaque vermelho/âmbar): leads cuja última mensagem é DO CLIENTE sem resposta da equipe (`last_customer_message_at > last_agent_message_at`), ordenada pelo maior tempo esperando, com "há Xh" + prévia da última msg + abrir conversa. É a seção nº 1 do Radar.
2. **Resumo do dia** (cabeçalho): 2-3 frases humanas montadas com números reais (template determinístico + toque da ficha mais urgente): "Bom dia! 4 clientes esperando resposta — a Fabiola pediu a fatura ontem. 12 retornos marcados para hoje somando R$ 23 mil." Sem chamada extra de LLM (dados já existem); a frase do destaque vem da ficha mais urgente.
3. **Reorganização do Radar:** seletor de funil + busca + seções colapsáveis com contadores; "Chamar hoje/Promissores/Esfriando" viram seções secundárias abaixo de "Esperando você".

## FASE 2 — Funil do gestor + pós-venda

4. **Promissores por etapa:** agrupamento por etapa do funil com soma de `valor_estimado` por grupo ("Proposta: 5 leads · R$ 38.000") — colunas compactas ou grupos empilhados.
5. **Melhores fichas:** ranking dos leads mais quentes do funil (critério composto: temperatura + valor + nota do atendimento + recência), "top 10 para focar".
6. **Compraram — relacionamento:** fila dos leads ganhos/com `ultima_compra` detectada, com a compra visível e cadência de pós-venda (X dias depois: "como está a mesa?"; depois aniversário da compra) — a régua de CS da proposta Ciafal.

## FASE 3 — Memória temporal (o diferencial)

7. **Lembretes extraídos da conversa:** o prompt do insight passa a extrair também `lembretes: [{ motivo, quando }]` de falas com tempo ("sem dinheiro agora", "só depois da reforma", "me chama em outubro", "daqui 2 meses") — data resolvida pela IA relativa à data da mensagem. Tabela nova `LeadLembrete` (lead_id, tenant_id, motivo, dito_em, avisar_em, origem 'ia'|'manual', status pendente|feito|descartado). Regras: nunca inventar; só criar quando o cliente deu um marco temporal explícito ou fortemente implícito.
8. **Radar — seção "Lembretes de hoje":** quando `avisar_em` vence, o lead aparece COM DESTAQUE e o contexto original ("Em 26/08 ele disse: 'agora estou sem dinheiro, talvez em outubro'"), botões concluir/adiar/descartar + msg sugerida de retomada.
9. Usuário também pode criar lembrete manual na ficha (mesmo mecanismo).

## FASE 4 — IA que decide

10. **Temperatura automática:** na geração da ficha a IA também devolve `temperatura_sugerida` + justificativa; o worker APLICA a mudança (com registro em atividade/timeline "IA: MORNO→QUENTE — cliente pediu orçamento e prazo") quando o toggle do tenant estiver ligado (`ia_ajusta_temperatura`, default ON, em Ajustes); sempre reversível na mão.
11. **Sugestão de etapa:** a ficha ganha "parece pronto para <etapa> — mover?" (aceite 1 clique move + registra; recusa registra e a IA não re-sugere a mesma transição por N dias). NUNCA move etapa sozinha — etapa é decisão humana (diferente de temperatura, que é qualificação).

## FASE 5 — Financeiro + Ajuda

12. **Dashboard financeira:** pipeline em R$ por etapa (funil visual), previsão ponderada (R$ × probabilidade por etapa, configurável com defaults), ganhos do mês vs anterior, ticket médio, top oportunidades abertas.
13. **Sistema de ajuda:** componente `Ajuda` ("?") reutilizável por seção + página/painel "Como funciona o CRM" cobrindo Radar, Ficha, Kanban, Views, Follow-up — texto claro e curto por função.

## Notas técnicas

- `last_customer_message_at`/`last_agent_message_at` já existem no Lead (schema) — Fase 1 é query+UI, sem migration.
- Fases 3 e 4 mexem em prompt+sanitizador+worker (padrão já maduro das entregas de 25-26/08) + 1 migration manual cada (LeadLembrete; nada na 4 — temperatura já existe no Lead).
- Custo IA: zero chamadas novas (tudo pega carona na geração da ficha existente).
- Cada fase = 1 plano SDD próprio; ordem 1→5; cada uma entrega valor sozinha.
