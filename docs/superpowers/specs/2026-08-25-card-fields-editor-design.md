# Editor de campos do card (kanban) — Design

Follow-up do plano `2026-08-25-lead-views.md`: o caminho de leitura de `card_fields` está no ar (LeadCard gateia 5 blocos via `mostrar()`), mas nenhuma UI grava o campo. Este spec cria o editor.

## Objetivo

Popover "Campos do card" na ViewBar, visível apenas em `mode='kanban'`, que edita `config.card_fields` da view ativa (ou do estado sujo sem view) pelos mecanismos já existentes.

## Componente

`apps/web/src/components/leads/card-fields-menu.tsx` (componente novo — a ViewBar já tem ~336 linhas):

```typescript
interface CardFieldsMenuProps {
  value: string[];                    // config.card_fields ([] = tudo)
  onChange: (fields: string[]) => void;
}
```

- Botão-ícone (`LayoutList` de lucide, tooltip "Campos do card") + shadcn `Popover`.
- Lista fixa de 5 checkboxes, rótulos em pt-BR:
  - `valor_estimado` — Valor estimado
  - `tags` — Tags
  - `telefone` — Telefone
  - `temperatura` — Temperatura
  - `proximo_followup` — Próximo follow-up
- Sem busca, sem drag: 5 itens, a ordem não importa (o card tem layout fixo).
- Identidade do card (nome, foto, badge de não lidas, alertas) NUNCA aparece no menu — não é configurável.

## Semântica

- `value: []` (default/legado) = mostra tudo → os 5 aparecem **marcados**.
- Desmarcar qualquer um emite lista explícita com os marcados restantes.
- Se o usuário marcar de volta até os 5 → emite `[]` (volta ao default, evita view "explícita" idêntica ao tudo).
- Mínimo 1 marcado: o último checkbox marcado fica `disabled` — `[]` já significa "tudo", não há representação para "nenhum" sem mudar a API (fora de escopo).

## Integração na ViewBar

`view-bar.tsx`: renderizar `<CardFieldsMenu value={view.config.card_fields} onChange={...}>` ao lado do botão Filtros, somente quando `mode === 'kanban'`. O `onChange` monta a config nova via `fromSavedConfig({ ...view.config, card_fields: fields })` — round-trip pela lib, nunca literal (ordem de chaves afeta `configIgual`). Salvar/Descartar/Salvar como nova seguem o estado sujo já existente; nenhuma mudança no hook.

## API

Nenhuma. `sanitizarConfig` já aceita as 5 chaves (`valor_estimado` é native, `tags`/`telefone`/`temperatura`/`proximo_followup` estão em NATIVE_FIELDS/PSEUDO_COLUNAS).

## Testes e verificação

- Jest do web só cobre `lib/` — sem teste unitário do componente; a lógica marcado↔lista é trivial e vive no componente.
- `npx tsc --noEmit` + `npm run build` em apps/web.
- Visual: kanban → marcar só Valor estimado → cards escondem tags/telefone/temperatura/follow-up; "Salvar" persiste; recarregar mantém.

## Fora de escopo

- "Nenhum campo" no card (exigiria sentinela na API).
- Editor no modo Lista (card_fields é só kanban).
- Campos customizados no card (o LeadCard não os renderiza hoje).
