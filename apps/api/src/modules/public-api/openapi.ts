/**
 * Spec OpenAPI 3.0.3 da API pública. Servido em GET /api/v1/openapi.json
 * (público, sem auth) para import no Postman/Insomnia e geração de SDK.
 * Mantenha em sincronia ao adicionar/alterar endpoints.
 */
const SERVER_URL =
  (process.env.PUBLIC_API_URL && `${process.env.PUBLIC_API_URL}/api/v1`) ||
  'https://api.crmpro.uk/api/v1';

const contactSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    email: { type: 'string', nullable: true },
    phone: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['OPEN', 'PENDING', 'RESOLVED'] },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const messageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    direction: { type: 'string', enum: ['incoming', 'outgoing'] },
    type: { type: 'string' },
    text: { type: 'string', nullable: true },
    media_url: { type: 'string', nullable: true },
    status: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, message: { type: 'string' } },
};

const errResp = (desc: string) => ({
  description: desc,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'CRM WhatsApp — API Pública',
    version: '1.0.0',
    description:
      'API REST para integrações externas. Autenticação por API key (Bearer). ' +
      '`user`/`contact` e `conversation` referem-se ao mesmo recurso (contato/lead); ' +
      'conversation_id == id do contato.',
  },
  servers: [{ url: SERVER_URL }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key no formato crmk_… (crie em Configurações → API Keys).',
      },
    },
    schemas: {
      Contact: contactSchema,
      Message: messageSchema,
      Error: errorSchema,
    },
  },
  paths: {
    '/users': {
      get: {
        summary: 'Listar contatos',
        tags: ['Contatos'],
        security: [{ bearerAuth: ['contacts:read'] }],
        parameters: [
          { name: 'email', in: 'query', schema: { type: 'string' } },
          { name: 'phone', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Lista paginada',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
                    pagination: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errResp('Token ausente/inválido'),
          '403': errResp('Escopo insuficiente'),
        },
      },
      post: {
        summary: 'Criar contato',
        tags: ['Contatos'],
        security: [{ bearerAuth: ['contacts:write'] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'phone'],
                properties: {
                  name: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Criado', content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } } },
          '400': errResp('Dados inválidos'),
          '409': errResp('Contato já existe'),
        },
      },
    },
    '/users/{id}': {
      get: {
        summary: 'Buscar contato',
        tags: ['Contatos'],
        security: [{ bearerAuth: ['contacts:read'] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Contato', content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } } },
          '404': errResp('Não encontrado'),
        },
      },
      patch: {
        summary: 'Atualizar contato',
        tags: ['Contatos'],
        security: [{ bearerAuth: ['contacts:write'] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', nullable: true },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Atualizado', content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } } },
          '404': errResp('Não encontrado'),
        },
      },
    },
    '/conversations': {
      get: {
        summary: 'Listar conversas',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['conversations:read'] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'pending', 'resolved'] } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Lista paginada de conversas',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          conversation_id: { type: 'string' },
                          contact: { $ref: '#/components/schemas/Contact' },
                          status: { type: 'string' },
                        },
                      },
                    },
                    pagination: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Enviar mensagem',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['conversations:write'] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['user_id', 'message'],
                properties: {
                  user_id: { type: 'string', format: 'uuid' },
                  message: { type: 'string' },
                  channel: { type: 'string', enum: ['whatsapp'], default: 'whatsapp' },
                  type: { type: 'string', enum: ['text'], default: 'text' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Enfileirada',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    conversation_id: { type: 'string' },
                    status: { type: 'string' },
                    channel: { type: 'string' },
                    type: { type: 'string' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '404': errResp('Contato não encontrado'),
        },
      },
    },
    '/conversations/{id}': {
      get: {
        summary: 'Histórico da conversa',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['conversations:read'] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          '200': {
            description: 'Conversa',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    conversation_id: { type: 'string' },
                    contact: { $ref: '#/components/schemas/Contact' },
                    status: { type: 'string' },
                    messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                  },
                },
              },
            },
          },
          '404': errResp('Não encontrada'),
        },
      },
    },
    '/conversations/{id}/status': {
      patch: {
        summary: 'Atualizar status',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['conversations:write'] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', example: 'resolved' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Atualizado' },
          '400': errResp('Status inválido'),
          '404': errResp('Não encontrada'),
        },
      },
    },
    '/conversations/{id}/tags': {
      post: {
        summary: 'Adicionar etiquetas',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['tags:write'] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tags'],
                properties: { tags: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Adicionadas' },
          '404': errResp('Não encontrada'),
        },
      },
    },
    '/sectors': {
      get: {
        summary: 'Listar setores',
        description:
          'Retorna os setores ativos do tenant. Use o `id` retornado como `sector_id` ' +
          'ao transferir uma conversa para um setor.',
        tags: ['Setores'],
        security: [{ bearerAuth: ['conversations:read'] }],
        responses: {
          '200': {
            description: 'Lista de setores ativos',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          name: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errResp('Token ausente/inválido'),
          '403': errResp('Escopo insuficiente'),
        },
      },
    },
    '/conversations/{id}/sector': {
      post: {
        summary: 'Transferir conversa para um setor',
        description:
          'Move a conversa para o setor informado e a distribui automaticamente entre os ' +
          'agentes ativos do setor seguindo **round-robin** (fila circular justa, não ' +
          'aleatória). A ordem é estável e o ponteiro da fila é persistido por setor — ' +
          'chamadas manuais (esta rota) e o recebimento automático de novas conversas ' +
          'avançam o MESMO ponteiro.\n\n' +
          'Exemplo — setor "Atacado" com os agentes Adjaine e Romilda:\n' +
          '1ª conversa → Adjaine · 2ª → Romilda · 3ª → Adjaine · 4ª → Romilda … e assim por diante.\n\n' +
          'Se um agente for desativado no meio do rodízio, ele sai da fila e a próxima ' +
          'conversa cai no próximo agente ativo. Se o setor não tiver NENHUM agente ativo, ' +
          'a conversa fica sem responsável (em espera) e retorna `status: "waiting"` ' +
          '(`responsavel_id: null`); caso contrário retorna `status: "assigned"` com o ' +
          '`responsavel_id` do agente escolhido.',
        tags: ['Conversas'],
        security: [{ bearerAuth: ['conversations:write'] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sector_id'],
                properties: {
                  sector_id: { type: 'string', format: 'uuid', description: 'ID do setor (ver GET /sectors)' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Conversa movida',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    conversation_id: { type: 'string', format: 'uuid' },
                    sector_id: { type: 'string', format: 'uuid' },
                    responsavel_id: { type: 'string', format: 'uuid', nullable: true },
                    status: { type: 'string', enum: ['assigned', 'waiting'] },
                  },
                },
                examples: {
                  assigned: {
                    summary: 'Distribuída em round-robin (ex.: caiu na Adjaine)',
                    value: {
                      conversation_id: '11111111-1111-1111-1111-111111111111',
                      sector_id: '22222222-2222-2222-2222-222222222222',
                      responsavel_id: '33333333-3333-3333-3333-333333333333',
                      status: 'assigned',
                    },
                  },
                  waiting: {
                    summary: 'Setor sem agentes ativos — em espera',
                    value: {
                      conversation_id: '11111111-1111-1111-1111-111111111111',
                      sector_id: '22222222-2222-2222-2222-222222222222',
                      responsavel_id: null,
                      status: 'waiting',
                    },
                  },
                },
              },
            },
          },
          '400': errResp('Setor inválido, inativo ou de outro tenant'),
          '404': errResp('Conversa não encontrada'),
        },
      },
    },
  },
} as const;
