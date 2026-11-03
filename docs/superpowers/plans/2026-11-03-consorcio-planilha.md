# Consórcio PL Sheet Import Implementation Plan

**Goal:** importar formulários de consórcio no funil PL, preservando carteira e importação dos parceiros.
**Architecture:** motor existente com fontes independentes; parser específico e deduplicação conservadora. Campos customizados existentes, sem schema novo.
**Tech Stack:** NestJS, Prisma, Jest, Next.js.
**Spec:** ../specs/2026-11-03-consorcio-planilha-design.md

## Constraints
- Tenant a44772ed-1382-4400-84fc-3fa350e23e42; pipeline 6f749216-8d83-44ed-8fd0-1c57720c9f11.
- Preservar atribuições/etapas; nomes iguais não provam duplicidade.
- Não interpretar faixas como valores exatos; não inventar tipo de veículo.
- Testes de Meta não viram leads. Fonte privada/HTML deve falhar sem gravar.
- Execução leve, sequencial; sem migrations/deploy amplo.

## Tasks
- [x] Testar parser do consórcio: campos em minúsculas, respostas legíveis, indecisos/ambos, linha de teste, telefone inválido.
- [x] Adaptar SheetImportService com fonte opcional e segundo provider; preservar configuração/padrões legados e namespace independente.
- [x] Testar duplicidade por telefone/e-mail: complementar um existente PL; bloquear ambiguidade/outro funil; preservar responsável/etapa/valor. Testar reexecução e isolamento de fonte.
- [x] Renderizar grupo de consórcio somente em leads do pipeline PL e testar filtro.
- [x] Rodar testes de importação/acesso, typecheck e revisão do diff.
- [x] Ativar somente a nova fonte, verificar contagens e fichas por leitura, reexecutar para comprovar idempotência. Documentar qualquer impedimento.

Validação local: 81 testes de importação, 86 de campos/vendas frontend, 115 de acesso/etapas e 197 na combinação de importação/acesso antes do reforço final; typecheck API/web e build API passaram. Lint sem erros (dois avisos preexistentes no Kanban). Revisão independente sem bloqueios após proteger concorrência entre fontes e edições/estado da linha.

Produção, 03/11/2026: release 34dadc8, CI e Vercel concluídos; backend compilado e atualizado isoladamente. 19 novos leads, 1 linha de teste ignorada, zero erros. Total PL 39 → 58. Snapshot dos 282 leads anteriores confirmou responsáveis/etapas/funis/valores preservados. Nova execução com ledger persistido: zero criações/anexações. GETs e navegador confirmaram ficha para Taynara/Paloma; Comercial não vê novos sem dono nem acessa sua ficha direta; questionário não aparece em parceiros. Nenhuma mensagem enviada e nenhum dado de teste criado. Configuração anterior preservada com backup seguro e imagem anterior etiquetada na VPS.
