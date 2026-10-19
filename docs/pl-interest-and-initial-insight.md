# Consórcio PL: bem de interesse e ficha inicial

Escopo: tenant `a44772ed-1382-4400-84fc-3fa350e23e42`, pipeline `6f749216-8d83-44ed-8fd0-1c57720c9f11`.

O campo opcional `bem_de_interesse` mantém os valores antigos Carro/Imóvel e oferece Imóvel, Construção, Reforma, Casa, Apartamento, Carro, Veículo novo, Veículo seminovo e Outros. A opção Outros exibe `outro_bem_de_interesse` para texto livre. O cartão PL mostra a categoria e, quando aplicável, o detalhe. Nenhum lead antigo é classificado por suposição.

A mesma geração da Ficha 360 extrai interesse de uma fala explícita do cliente ou resposta de formulário. A saída é validada contra as opções, confiança mínima e evidência literal do material recebido. Respostas sem evidência ou ambíguas são ignoradas. Preenchimentos existentes são preservados, inclusive alterações durante a geração. O registro condicional e o histórico são atômicos; a lista é invalidada antes da notificação. A IA não distribui leads nem altera valores por causa desta função.

## Formulários futuros

Nenhum site ou formulário externo foi conectado por esta alteração. Uma integração autenticada pode criar um lead em `POST /api/v1/users`, informando `pipeline_id` para escolher explicitamente o funil PL. A API valida o funil dentro do tenant da chave. Sem esse parâmetro, permanece o funil padrão anterior.

Enviar a resposta pronta em `dados_custom.bem_de_interesse`. Para Outros, enviar também `dados_custom.outro_bem_de_interesse`. Para pergunta aberta, enviar `dados_custom.objetivo_do_consorcio` (campo textarea apenas API). Exemplo:

```json
{
  "name": "Nome do cliente",
  "phone": "5531999999999",
  "pipeline_id": "6f749216-8d83-44ed-8fd0-1c57720c9f11",
  "dados_custom": {
    "objetivo_do_consorcio": "Quero reformar minha casa"
  }
}
```

Descrições recebidas pela API em leads PL sem categoria entram na fila existente, com atraso de dois minutos e deduplicação. Respostas prontas são salvas diretamente. O lead continua sem responsável até a distribuição manual.

## Ficha 360

O perfil restrito pode gerar a ficha somente dos próprios leads PL. Ao abrir uma ficha PL ausente ou sem resumo no Kanban ou página do lead, o navegador solicita uma geração, respeitando o limite de cinco minutos. Não repete a solicitação a cada atualização da tela.

Sem WhatsApp, a ficha PL pode usar apenas os dados reais de cadastro, nome e valor, esclarecendo as lacunas. Não presume objetivo, atendimento ou compra. Parceiros e demais tenants mantêm seu comportamento de geração anterior.

## Validação

Testes cobrem evidência, Outros, formulário antes de conversa, isolamento, preservação manual, concorrência, acesso à geração e seleção de funil da API. O modelo configurado foi validado com exemplos sintéticos de Reforma, Veículo seminovo, Outros/moto e escolha indefinida. Não foram criados leads de teste em produção.
