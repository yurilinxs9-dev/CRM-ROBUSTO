# Pré-atendimento com IA da Ferbraço (n8n)

Fluxo: [`ferbraco-pre-atendimento.json`](ferbraco-pre-atendimento.json). Mesmo
desenho do fluxo da Diplapel, mas a distribuição usa o rodízio do próprio CRM.

## O que ele faz

1. O CRM avisa o n8n de cada mensagem (`message.created`).
2. Segue só para **cliente sem vendedor**: lead novo no número principal (o
   lead nasce com o Thiago, dono do número) que ainda não foi direcionado.
   - Lead do Thiago criado há mais de 15 minutos é cliente antigo dele e não
     entra na triagem (`leadNovoMinutos`).
3. Primeira mensagem → envia as boas-vindas da Ferbraço pelo número principal.
4. Próximas mensagens → espera 40s (junta a rajada) → IA (DeepSeek) lê nome,
   cidade e materiais. Áudio é transcrito pelo Groq (Whisper).
5. Região:
   - Pompéu e Abaeté → setor `regiao pompeu e abaete` (Fabio)
   - Sul de Minas → setor `regiao sul de minas` (Adriano)
   - outra cidade → setor `vendas balcao ferbraco`, rodízio entre os 6
   - sem cidade → pergunta 1x; se continuar sem cidade, balcão
6. Manda "Em breve você será atendido…" pelo número principal, move o lead para
   o setor (`POST /api/v1/conversations/:id/sector` — o CRM sorteia o vendedor
   e passa a conversa para ele), anota o resumo na timeline do lead.
7. Opcional: avisa o vendedor no WhatsApp dele (nome, cidade, pedido, link).
8. Trava a triagem daquele cliente por 3 dias. Se o Thiago responder o cliente
   durante a triagem (celular ou CRM), a triagem também trava — inclusive se
   ele responder durante a espera de 40s (a trava é conferida de novo antes da
   IA). As mensagens automáticas do próprio fluxo não travam (são reconhecidas
   pelo texto).

## Configurar

**No CRM (logado como Thiago):**
1. Configurações > API Keys → criar chave com `contacts:read`,
   `contacts:write`, `conversations:read`, `conversations:write`.
2. Configurações > Webhooks → URL de produção do webhook do n8n
   (`…/webhook/ferbraco-pre-atendimento`), evento `message.created`.

**No n8n:**
1. Importar o JSON.
2. Credenciais (o n8n pede ao abrir os nós):
   - `CRM Ferbraço (API key)` — Header Auth: `Authorization` = `Bearer crmk_…`
   - `Redis account` — o mesmo Redis da Diplapel
   - `DeepSeek` — chave DeepSeek
   - `Groq (transcrição)` — Header Auth: `Authorization` = `Bearer gsk_…`
   - `Evolution Ferbraço (número principal)` — Header Auth: `apikey` = token da
     instância `thiago-henrique-gestor-comercial` (só se for usar o aviso no
     WhatsApp do vendedor)
3. Nó **Dados da mensagem**: conferir textos, `evolutionUrl` e preencher o
   `whatsapp` de cada vendedor que deve receber o aviso.
4. Ativar o workflow.

## Limites conhecidos

- O aviso do CRM não diz em qual número a mensagem chegou. O filtro é "lead
  novo do Thiago": os números do Fabio e do Adriano também são do Thiago, então
  um cliente novo que escrever direto neles também passa pela triagem (raro:
  1 lead em 14 dias).
- O aviso no WhatsApp do vendedor é uma conversa entre dois números conectados
  no CRM: cria um card "Ferbraço" no CRM do vendedor e um card do vendedor no
  CRM do Thiago. Por isso começa desligado (WhatsApp vazio).
- Foto sem texto vira "[enviou uma foto]" para a IA.
