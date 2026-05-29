'use client';

import { useState } from 'react';
import { Copy, Check, ChevronRight, Zap, ShieldCheck, AlertCircle, Download } from 'lucide-react';

// Base URL real (NEXT_PUBLIC_API_URL pode vir como "//host" — normaliza p/ https).
const RAW = process.env.NEXT_PUBLIC_API_URL || '';
const HOST = RAW.replace(/^https?:/i, '').replace(/^\/\//, '').replace(/\/$/, '');
const BASE = `https://${HOST || 'SEU_DOMINIO'}/api/v1`;

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-emerald-500',
  POST: 'bg-blue-500',
  PATCH: 'bg-amber-500',
  DELETE: 'bg-red-500',
};

const METHOD_BORDER: Record<string, string> = {
  GET: 'border-l-emerald-500',
  POST: 'border-l-blue-500',
  PATCH: 'border-l-amber-500',
  DELETE: 'border-l-red-500',
};

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group rounded-lg border bg-zinc-950 dark:bg-zinc-900">
      {lang && (
        <span className="absolute top-2 left-3 text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
          {lang}
        </span>
      )}
      <pre className="text-xs font-mono text-zinc-100 overflow-x-auto whitespace-pre p-3 pt-6">{code}</pre>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition"
        title="Copiar"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function MethodBadge({ m }: { m: string }) {
  return (
    <span className={`text-[11px] font-bold text-white px-2 py-0.5 rounded font-mono w-14 text-center ${METHOD_COLOR[m] ?? 'bg-zinc-500'}`}>
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
  defaultOpen?: boolean;
}

function Endpoint({ method, path, scope, desc, curl, response, defaultOpen = false }: EndpointProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`border rounded-lg overflow-hidden border-l-4 ${METHOD_BORDER[method] ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-accent/40 transition"
      >
        <MethodBadge m={method} />
        <code className="text-sm font-mono font-medium truncate">{path}</code>
        <span className="text-[11px] bg-secondary px-2 py-0.5 rounded ml-auto whitespace-nowrap font-mono">{scope}</span>
        <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t pt-3">
          <p className="text-sm text-muted-foreground">{desc}</p>
          <div>
            <div className="text-xs font-semibold mb-1 text-muted-foreground">Requisição</div>
            <CodeBlock code={curl} lang="bash" />
          </div>
          <div>
            <div className="text-xs font-semibold mb-1 text-muted-foreground">Resposta</div>
            <CodeBlock code={response} lang="json" />
          </div>
        </div>
      )}
    </div>
  );
}

const SCOPES: [string, string][] = [
  ['contacts:read', 'Ler contatos (GET /users)'],
  ['contacts:write', 'Criar contatos (POST /users)'],
  ['conversations:read', 'Ler conversas e mensagens'],
  ['conversations:write', 'Enviar mensagens e mudar status'],
  ['tags:write', 'Adicionar etiquetas'],
];

const STATUS: [string, string][] = [
  ['200', 'OK — processado (GET, PATCH)'],
  ['201', 'Created — recurso criado (POST)'],
  ['400', 'Bad Request — JSON inválido / dados faltando'],
  ['401', 'Unauthorized — token ausente ou inválido'],
  ['403', 'Forbidden — escopo insuficiente'],
  ['404', 'Not Found — contato/conversa inexistente'],
  ['409', 'Conflict — recurso já existe'],
  ['429', 'Too Many Requests — limite 120 req/min por chave'],
  ['500', 'Internal Server Error'],
];

export function ApiDocs() {
  return (
    <div className="space-y-8 text-sm max-w-3xl">
      {/* Quickstart */}
      <section className="rounded-xl border bg-gradient-to-br from-primary/5 to-transparent p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Zap className="w-4 h-4 text-primary" /> Início rápido
        </div>
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>Crie uma chave acima (<strong>Nova chave</strong>) e copie o token <code className="bg-secondary px-1 rounded">crmk_…</code> (exibido só uma vez).</li>
          <li>Envie o token no header <code className="bg-secondary px-1 rounded">Authorization</code> em toda requisição.</li>
          <li>Faça a chamada — respostas e payloads em JSON.</li>
        </ol>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div>
            <div className="text-xs font-semibold mb-1">Base URL</div>
            <CodeBlock code={BASE} />
          </div>
          <div>
            <div className="text-xs font-semibold mb-1">Headers</div>
            <CodeBlock code={`Authorization: Bearer crmk_...\nContent-Type: application/json`} />
          </div>
        </div>
        <CodeBlock
          lang="bash"
          code={`curl ${BASE}/users \\
  -H "Authorization: Bearer crmk_seu_token_aqui"`}
        />
        <a
          href={`${BASE}/openapi.json`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-xs font-medium border rounded-md px-3 py-1.5 hover:bg-accent transition"
        >
          <Download className="w-3.5 h-3.5" />
          Baixar OpenAPI (importável no Postman / Insomnia)
        </a>
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span><code className="bg-secondary px-1 rounded">user</code>/<code className="bg-secondary px-1 rounded">contact</code> e <code className="bg-secondary px-1 rounded">conversation</code> são o mesmo recurso (o contato/lead). <code className="bg-secondary px-1 rounded">conversation_id</code> = id do contato.</span>
        </p>
      </section>

      {/* Escopos */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="w-4 h-4 text-primary" /> Escopos
        </div>
        <p className="text-xs text-muted-foreground">Cada chave tem escopos; a rota exige o escopo indicado. Conceda só o necessário.</p>
        <div className="border rounded-lg divide-y">
          {SCOPES.map(([s, d]) => (
            <div key={s} className="flex items-center gap-3 px-3 py-2 text-sm">
              <code className="font-mono text-xs bg-secondary px-2 py-0.5 rounded w-44 flex-shrink-0">{s}</code>
              <span className="text-muted-foreground">{d}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Endpoints — Contatos */}
      <section className="space-y-2">
        <h4 className="font-semibold text-base">Contatos</h4>
        <div className="space-y-2">
          <Endpoint
            method="GET"
            path="/users"
            scope="contacts:read"
            defaultOpen
            desc="Lista contatos. Filtros opcionais: ?email= ?phone= ?limit= (1-100, padrão 50) ?offset=."
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
            desc="Busca um contato pelo id. 404 se não existir."
            curl={`curl ${BASE}/users/UUID \\
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
            desc="Cria um contato. pipeline/estágio/instância default do workspace são resolvidos automaticamente."
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
            method="PATCH"
            path="/users/:id"
            scope="contacts:write"
            desc="Atualiza um contato. Envie ao menos um campo: name, email ou tags."
            curl={`curl -X PATCH ${BASE}/users/UUID \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "João S. Souza", "tags": ["cliente"] }'`}
            response={`{
  "id": "uuid",
  "name": "João S. Souza",
  "email": "joao@email.com",
  "phone": "5511988887777",
  "tags": ["cliente"],
  "status": "OPEN",
  "created_at": "2026-05-29T12:00:00.000Z"
}`}
          />
        </div>
      </section>

      {/* Endpoints — Conversas */}
      <section className="space-y-2">
        <h4 className="font-semibold text-base">Conversas</h4>
        <div className="space-y-2">
          <Endpoint
            method="GET"
            path="/conversations"
            scope="conversations:read"
            desc="Lista conversas (contatos). Filtros: ?status=open|pending|resolved ?tag= ?limit= ?offset=."
            curl={`curl "${BASE}/conversations?status=pending&limit=20" \\
  -H "Authorization: Bearer crmk_..."`}
            response={`{
  "data": [
    {
      "conversation_id": "uuid",
      "contact": { "id": "uuid", "name": "Maria", "phone": "5511...", "status": "PENDING" },
      "status": "PENDING"
    }
  ],
  "pagination": { "total": 1, "limit": 20, "offset": 0 }
}`}
          />
          <Endpoint
            method="POST"
            path="/conversations"
            scope="conversations:write"
            desc="Envia mensagem ao contato (WhatsApp). user_id = id do contato. Também aceita POST /users/:id/conversations."
            curl={`curl -X POST ${BASE}/conversations \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "UUID",
    "message": "Olá! Como podemos ajudar?",
    "channel": "whatsapp",
    "type": "text"
  }'`}
            response={`// 201 Created
{
  "id": "uuid_mensagem",
  "conversation_id": "UUID",
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
            desc="Contato + mensagens recentes (notas internas não são expostas). ?limit= (1-100, padrão 50)."
            curl={`curl "${BASE}/conversations/UUID?limit=50" \\
  -H "Authorization: Bearer crmk_..."`}
            response={`{
  "conversation_id": "uuid",
  "contact": { "id": "uuid", "name": "Maria", "phone": "5511...", "status": "OPEN" },
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
            desc="Atualiza o status. Valores: open | pending | resolved (sinônimos PT: aberta, pendente/em andamento, resolvida/fechada)."
            curl={`curl -X PATCH ${BASE}/conversations/UUID/status \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "status": "resolved" }'`}
            response={`{ "conversation_id": "uuid", "status": "RESOLVED" }`}
          />
          <Endpoint
            method="POST"
            path="/conversations/:id/tags"
            scope="tags:write"
            desc="Adiciona etiquetas ao contato (idempotente — não duplica)."
            curl={`curl -X POST ${BASE}/conversations/UUID/tags \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "tags": ["suporte", "urgente"] }'`}
            response={`// 201 Created
{ "conversation_id": "uuid", "tags": ["suporte", "urgente"] }`}
          />
        </div>
      </section>

      {/* Boas práticas */}
      <section className="space-y-2">
        <h4 className="font-semibold text-base">Boas práticas</h4>
        <ul className="text-sm text-muted-foreground space-y-1.5 list-disc list-inside">
          <li>
            <strong>Idempotência:</strong> em POST/PATCH, envie o header{' '}
            <code className="bg-secondary px-1 rounded">Idempotency-Key</code> (um id único por operação).
            Se a requisição for repetida com a mesma chave (ex.: retry de rede), a resposta original é
            devolvida sem duplicar a ação — a resposta vem com{' '}
            <code className="bg-secondary px-1 rounded">Idempotent-Replayed: true</code>.
          </li>
          <li>
            <strong>Rate limit:</strong> 120 requisições por minuto por chave. Acima disso retorna{' '}
            <code className="bg-secondary px-1 rounded">429</code>.
          </li>
        </ul>
        <CodeBlock
          lang="bash"
          code={`curl -X POST ${BASE}/conversations \\
  -H "Authorization: Bearer crmk_..." \\
  -H "Idempotency-Key: pedido-12345" \\
  -H "Content-Type: application/json" \\
  -d '{ "user_id": "UUID", "message": "Oi!" }'`}
        />
      </section>

      {/* Status codes */}
      <section className="space-y-2">
        <h4 className="font-semibold text-base">Códigos de status & erros</h4>
        <div className="border rounded-lg divide-y">
          {STATUS.map(([code, desc]) => (
            <div key={code} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <code className={`font-mono font-bold w-10 ${code.startsWith('2') ? 'text-emerald-600' : code.startsWith('4') ? 'text-amber-600' : 'text-red-600'}`}>{code}</code>
              <span className="text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
        <div className="pt-1">
          <div className="text-xs font-semibold mb-1 text-muted-foreground">Formato de erro</div>
          <CodeBlock lang="json" code={`{
  "error": "Unauthorized",
  "message": "Token de API inválido ou não fornecido."
}`} />
        </div>
      </section>
    </div>
  );
}
