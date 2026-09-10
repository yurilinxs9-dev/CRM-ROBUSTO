# Importacao Meta Lead Ads — retomada 2026-09-10

Implementacao concluida na branch feat/importacao-planilha-meta.

- Task 6 revisada: recordFirstTouch captura seus erros; anexos preservam dono/etapa e agora emitem lead:updated.
- Task 7 concluida: CSV no boot/cron, hash, dedupe, retentativas e registro no AppModule.
- Task 10 concluida: compose, env example e documentacao.
- Regra comercial ME/LTDA isolada pelo tenant a44772ed-1382-4400-84fc-3fa350e23e42 no contexto do prompt; teste cobre piloto e demais clientes.
- Testes: 5 suites, 290 testes aprovados (sheet-import e lead-insights, runInBand). Typecheck e lint --quiet aprovados.
- Testes novos confirmaram RED antes da implementacao (sheetUrl ausente; politica vazando; WS ausente) e GREEN apos correcoes.
- Producao consultada apenas em leitura: HEAD 93e4011 e alteracoes locais nginx/scripts. HEAD e ancestral da branch; preservar arquivos locais no deploy.
- Nao houve migration, importacao real, merge, push ou deploy nesta retomada.

## Ativacao pendente

Seguir Task 11 do plano, preservando alteracoes locais do servidor. Aplicar somente a migration aditiva via DIRECT_URL e script apply-sheet-import.mjs. Nunca migrate deploy ou db push.
Configurar explicitamente tenant, sheet, pipeline 4321b42f-670c-418e-8121-463446b0694a e stage e1676a27-c392-4a95-8666-86d914fd0478. Publicar somente backend.
Verificar contagens reais (123 era a contagem historica, nao uma promessa atual), segunda rodada sem duplicacao, campos no Kanban e Ficha IA.
