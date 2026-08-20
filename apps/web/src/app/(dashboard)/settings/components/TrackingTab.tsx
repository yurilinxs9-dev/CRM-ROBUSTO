'use client';

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Aba "Rastreamento": entrega prontos os dois textos que o cliente cola uma vez
 * (o modelo de acompanhamento do Google Ads e o snippet do site) e explica o
 * que cada um faz. É toda a configuração que a atribuição exige — não há conta
 * de anúncios para conectar nem credencial para preencher.
 */

const TRACKING_TEMPLATE =
  '{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}' +
  '&utm_content={creative}&utm_term={keyword}&matchtype={matchtype}' +
  '&network={network}&device={device}&gclid={gclid}';

/** O snippet roda no site do cliente, então é JS puro, sem dependência. */
function buildSnippet(apiBase: string, token: string): string {
  return `<script>
(function () {
  var API = ${JSON.stringify(`${apiBase}/api/track/c`)};
  var TOKEN = ${JSON.stringify(token)};
  var COOKIE = 'crm_attr';
  var DIAS = 90;

  var CAMPOS = ['gclid','wbraid','gbraid','fbclid','utm_source','utm_medium',
    'utm_campaign','utm_term','utm_content','campaignid','adgroupid','creative',
    'keyword','matchtype','network','device'];

  function ler() {
    var m = document.cookie.match(/(?:^|;\\s*)crm_attr=([^;]*)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; }
  }

  function gravar(d) {
    var exp = new Date(Date.now() + DIAS * 864e5).toUTCString();
    document.cookie = COOKIE + '=' + encodeURIComponent(JSON.stringify(d)) +
      ';expires=' + exp + ';path=/;SameSite=Lax';
  }

  // First-touch: o primeiro clique é o que trouxe a pessoa. Só grava se ainda
  // não houver cookie E se esta visita tiver alguma marcação de origem.
  var atual = ler();
  if (!atual) {
    var q = new URLSearchParams(location.search);
    var d = {};
    var tem = false;
    for (var i = 0; i < CAMPOS.length; i++) {
      var v = q.get(CAMPOS[i]);
      if (v) { d[CAMPOS[i]] = v; tem = true; }
    }
    d.lp = location.href;
    d.rf = document.referrer || '';
    d.ts = Date.now();
    if (tem || d.rf) { gravar(d); atual = d; }
  }

  function codigo() {
    var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = '';
    for (var i = 0; i < 8; i++) r += s.charAt(Math.floor(Math.random() * s.length));
    return r;
  }

  // Preenche os campos ocultos do formulário, se existirem na página.
  function preencherForm() {
    if (!atual) return;
    for (var k in atual) {
      if (!Object.prototype.hasOwnProperty.call(atual, k)) continue;
      var el = document.querySelector('input[name="crm_' + k + '"]');
      if (el) el.value = atual[k];
    }
  }

  // Marca os links de WhatsApp: gera um código, avisa o CRM e põe o código no
  // texto pré-preenchido. É assim que o clique no site encontra a conversa.
  function marcarLinks() {
    var links = document.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"]');
    for (var i = 0; i < links.length; i++) {
      (function (a) {
        if (a.getAttribute('data-crm-attr')) return;
        a.setAttribute('data-crm-attr', '1');
        a.addEventListener('click', function () {
          var k = codigo();
          var p = new URLSearchParams();
          p.set('t', TOKEN);
          p.set('k', k);
          if (atual) {
            for (var campo in atual) {
              if (Object.prototype.hasOwnProperty.call(atual, campo)) p.set(campo, atual[campo]);
            }
          }
          new Image().src = API + '?' + p.toString();

          try {
            var u = new URL(a.href);
            var texto = u.searchParams.get('text') || 'Olá! Vim pelo site.';
            u.searchParams.set('text', texto + ' (ref: ' + k + ')');
            a.href = u.toString();
          } catch (e) { /* link fora do padrão: segue sem o código */ }
        });
      })(links[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { preencherForm(); marcarLinks(); });
  } else {
    preencherForm();
    marcarLinks();
  }
})();
</script>`;
}

function Bloco({ titulo, texto, ajuda }: { titulo: string; texto: string; ajuda: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border p-4"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 className="font-semibold text-sm">{titulo}</h4>
          <div className="text-sm text-muted-foreground mt-1">{ajuda}</div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(texto).then(
              () => toast.success('Copiado'),
              () => toast.error('Não foi possível copiar'),
            );
          }}
        >
          <Copy className="w-4 h-4 mr-2" /> Copiar
        </Button>
      </div>
      <pre
        className="text-xs rounded-lg p-3 overflow-x-auto mt-3"
        style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}
      >
        {texto}
      </pre>
    </div>
  );
}

export function TrackingTab() {
  const { data, isLoading } = useQuery<{ site_token: string }>({
    queryKey: ['attribution-site-token'],
    queryFn: async () => (await api.get('/api/attribution/site-token')).data,
  });

  const apiBase = process.env.NEXT_PUBLIC_API_URL || '';

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Rastreamento de origem</h3>
        <p className="text-sm text-muted-foreground">
          Duas colagens, uma vez cada, e o CRM passa a saber de onde vem cada lead — quanto é
          tráfego pago e quanto é orgânico. Anúncios da Meta que caem no WhatsApp já são
          identificados sozinhos, sem nenhuma configuração.
        </p>
      </div>

      <Bloco
        titulo="1. Modelo de acompanhamento — Google Ads"
        texto={TRACKING_TEMPLATE}
        ajuda={
          <>
            Cole em <strong>Configurações da conta › Acompanhamento › Modelo de acompanhamento</strong>,
            no nível da conta. Vale para todas as campanhas, inclusive as criadas depois. Confirme
            também que o <em>tagging automático</em> (gclid) está ligado.
          </>
        }
      />

      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <Bloco
          titulo="2. Snippet do site"
          texto={buildSnippet(apiBase, data?.site_token ?? '')}
          ajuda={
            <>
              Cole antes do <code className="text-xs bg-secondary px-1 py-0.5 rounded">&lt;/body&gt;</code> em
              todas as páginas. Ele guarda a origem do primeiro clique por 90 dias, preenche os
              campos ocultos do formulário e marca os links de WhatsApp.
            </>
          }
        />
      )}

      <div
        className="rounded-xl border p-4 text-sm"
        style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
      >
        <h4 className="font-semibold mb-2">Formulário do site</h4>
        <p className="text-muted-foreground">
          Para que o formulário carregue a origem, acrescente campos ocultos com o prefixo{' '}
          <code className="text-xs bg-secondary px-1 py-0.5 rounded">crm_</code> — por exemplo{' '}
          <code className="text-xs bg-secondary px-1 py-0.5 rounded">
            &lt;input type=&quot;hidden&quot; name=&quot;crm_gclid&quot;&gt;
          </code>
          . O snippet os preenche sozinho. Depois, mande esses valores no campo{' '}
          <code className="text-xs bg-secondary px-1 py-0.5 rounded">attribution</code> do{' '}
          <code className="text-xs bg-secondary px-1 py-0.5 rounded">POST /v1/users</code> da API
          pública.
        </p>
      </div>
    </div>
  );
}
