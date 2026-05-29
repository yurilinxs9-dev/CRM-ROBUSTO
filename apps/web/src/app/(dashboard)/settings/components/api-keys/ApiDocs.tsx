'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// Base URL real (NEXT_PUBLIC_API_URL pode vir como "//host" — normaliza p/ https).
const RAW = process.env.NEXT_PUBLIC_API_URL || '';
const HOST = RAW.replace(/^https?:/i, '').replace(/^\/\//, '').replace(/\/$/, '');
const BASE = `https://${HOST || 'SEU_DOMINIO'}/api/v1`;

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-green-100 text-green-700',
  POST: 'bg-blue-100 text-blue-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-red-100 text-red-700',
};

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-secondary rounded p-3 text-xs font-mono overflow-x-auto whitespace-pre">{code}</pre>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 p-1 rounded bg-background/80 border opacity-0 group-hover:opacity-100 transition"
        title="Copiar"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function Method({ m }: { m: string }) {
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${METHOD_COLOR[m] ?? 'bg-secondary'}`}>
      {m}
    </span>
  );
}

interface EndpointProps {
  method: string;
  path: string;
  scope: string;
  desc: string;
  curl: string;
  response: string;
}

function Endpoint({ method, path, scope, desc, curl, response }: EndpointProps) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Method m={method} />
        <code className="text-sm font-mono font-medium">{path}</code>
        <span className="text-xs bg-secondary px-2 py-0.5 rounded ml-auto">{scope}</span>
      </div>
      <p className="text-sm text-muted-foreground">{desc}</p>
      <div>
        <div className="text-xs font-semibold mb-1">Requisição</div>
        <CodeBlock code={curl} />
      </div>
      <div>
        <div className="text-xs font-semibold mb-1">Resposta</div>
        <CodeBlock code={response} />
      </div>
    </div>
  );
}

const AUTH_CURL = `curl ${BASE}/users \\
  -H "Authorization: Bearer crmk_seu_token_aqui" \\
  -H "Content-Type: application/json"`;

export function ApiDocs() {
  return (
    <div className="space-y-6 text-sm">
      {/* Visão geral */}
      <section className="space-y-2">
        <h4 className="font-semibold">Visão geral</h4>
        <p className="text-muted-foreground">
          API REST para integrações externas (n8n, Make, Zapier, backend próprio).
          Todas as respostas são JSON. <code className="bg-secondary px-1 rounded">user</code> /{' '}
          <code className="bg-secondary px-1 rounded">contact</code> e{' '}
          <code className="bg-secondary px-1 rounded">conversation</code> referem-se ao mesmo
          recurso: o contato/lead (o <code className="bg-secondary px-1 rounded">conversation_id</code> é o id do contato).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
          <div>
            <div className="text-xs font-semibold mb-1">Base URL</div>
            <CodeBlock code={BASE} />
          </div>
          <div>
            <div className="text-xs font-semibold mb-1">Autenticação (header)</div>
            <CodeBlock code={`Authorization: Bearer crmk_...\nContent-Type: application/json`} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Gere o token na aba acima (&quot;Nova chave&quot;). Ele é exibido uma única vez — guarde com segurança.
          Cada chave tem escopos; a rota exige o escopo indicado em cada endpoint.
        </p>
        <CodeBlock code={AUTH_CURL} />
      </section>

      {/* Endpoints */}
      <section className="space-y-3">
        <h4 className="font-semibold">Endpoints</h4>

        <Endpoint
          method="GET"
          path="/users"
          scope="contacts:read"
          desc="Lista contatos. Filtros opcionais: ?email=, ?phone=, ?limit= (1-100, padrão 50), ?offset=."
          curl={`curl "${BASE}/users?limit=20&phone=5511" \\
  -H "Authorization: Bearer crmk_..."`}
          response={`{
  "data": [
    {
      "id": "uuid",
      "name": "Maria Silva",
      "email": "maria@email.com",
      "phone": "5511999998888",
      "tags": ["cliente-vip"],
      "status": "OPEN",
      "created_at": "2026-05-29T10:00:00.000Z"
    }
  ],
  "pagination": { "total": 1, "limit": 20, "offset": 0 }
}`}
        />

        <Endpoint
          method="GET"
          path="/users/:id"
          scope="contacts:read"
          desc="Busca um contato específico pelo id. Retorna 404 se não existir."
          curl={`curl ${BASE}/users/UUID_DO_CONTATO \\
  -H "Authorization: Bearer crmk_..."`}
          response={`{
  "id": "uuid",
  "name": "Maria Silva",
  "email": "maria@email.com",
  "phone": "5511999998888",
  "tags": [],
  "status": "OPEN",
  "created_at": "2026-05-29T10:00:00.000Z"
}`}
        />

        <Endpoint
          method="POST"
          path="/users"
          scope="contacts:write"
          desc="Cria um novo contato. pipeline, estágio e instância default do workspace são resolvidos automaticamente."
          curl={`curl -X POST ${BASE}/users \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "João Souza",
    "phone": "5511988887777",
    "email": "joao@email.com",
    "tags": ["lead-site"]
  }'`}
          response={`// 201 Created
{
  "id": "uuid",
  "name": "João Souza",
  "email": "joao@email.com",
  "phone": "5511988887777",
  "tags": ["lead-site"],
  "status": "OPEN",
  "created_at": "2026-05-29T12:00:00.000Z"
}`}
        />

        <Endpoint
          method="POST"
          path="/conversations"
          scope="conversations:write"
          desc="Envia uma mensagem ao contato (WhatsApp). user_id é o id do contato. Aceita também POST /users/:id/conversations."
          curl={`curl -X POST ${BASE}/conversations \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "UUID_DO_CONTATO",
    "message": "Olá! Como podemos ajudar?",
    "channel": "whatsapp",
    "type": "text"
  }'`}
          response={`// 201 Created
{
  "id": "uuid_da_mensagem",
  "conversation_id": "UUID_DO_CONTATO",
  "status": "queued",
  "channel": "whatsapp",
  "type": "text",
  "created_at": "2026-05-29T12:01:00.000Z"
}`}
        />

        <Endpoint
          method="GET"
          path="/conversations/:id"
          scope="conversations:read"
          desc="Retorna o contato + mensagens recentes (notas internas não são expostas). ?limit= (1-100, padrão 50)."
          curl={`curl "${BASE}/conversations/UUID_DO_CONTATO?limit=50" \\
  -H "Authorization: Bearer crmk_..."`}
          response={`{
  "conversation_id": "uuid",
  "contact": { "id": "uuid", "name": "Maria", "phone": "5511...", "status": "OPEN", "...": "" },
  "status": "OPEN",
  "messages": [
    {
      "id": "uuid",
      "direction": "incoming",
      "type": "text",
      "text": "Oi, tudo bem?",
      "media_url": null,
      "status": "delivered",
      "created_at": "2026-05-29T11:59:00.000Z"
    }
  ],
  "pagination": { "limit": 50, "count": 1 }
}`}
        />

        <Endpoint
          method="PATCH"
          path="/conversations/:id/status"
          scope="conversations:write"
          desc="Atualiza o status de atendimento. Valores aceitos: open | pending | resolved (também aceita sinônimos PT: aberta, pendente/em andamento, resolvida/fechada)."
          curl={`curl -X PATCH ${BASE}/conversations/UUID_DO_CONTATO/status \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "status": "resolved" }'`}
          response={`{ "conversation_id": "uuid", "status": "RESOLVED" }`}
        />

        <Endpoint
          method="POST"
          path="/conversations/:id/tags"
          scope="tags:write"
          desc="Adiciona uma ou mais etiquetas ao contato (idempotente — não duplica)."
          curl={`curl -X POST ${BASE}/conversations/UUID_DO_CONTATO/tags \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "tags": ["suporte", "urgente"] }'`}
          response={`// 201 Created
{ "conversation_id": "uuid", "tags": ["suporte", "urgente"] }`}
        />
      </section>

      {/* Status codes + erros */}
      <section className="space-y-2">
        <h4 className="font-semibold">Códigos de status</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          {[
            ['200', 'OK — requisição processada (GET, PATCH)'],
            ['201', 'Created — recurso criado (POST)'],
            ['400', 'Bad Request — JSON inválido ou dados faltando'],
            ['401', 'Unauthorized — token ausente ou inválido'],
            ['403', 'Forbidden — escopo insuficiente para a rota'],
            ['404', 'Not Found — contato/conversa não encontrado'],
            ['409', 'Conflict — recurso já existe (ex: telefone duplicado)'],
            ['429', 'Too Many Requests — limite de 120 req/min por chave'],
            ['500', 'Internal Server Error'],
          ].map(([code, desc]) => (
            <div key={code} className="flex gap-2">
              <code className="font-mono font-semibold w-9">{code}</code>
              <span className="text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
        <div className="pt-1">
          <div className="text-xs font-semibold mb-1">Formato de erro</div>
          <CodeBlock code={`{
  "error": "Unauthorized",
  "message": "Token de API inválido ou não fornecido."
}`} />
        </div>
      </section>
    </div>
  );
}
