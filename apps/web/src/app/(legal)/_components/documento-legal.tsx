import { Fragment } from 'react';

import { ATUALIZADO_EM, MARCADOR_PENDENTE, empresaCompleta } from '@/lib/legal/empresa';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Contrato de conteudo
// ---------------------------------------------------------------------------

/** Item de uma lista definida: um termo curto e a explicacao dele. */
export interface ItemLista {
  termo: string;
  texto: string;
}

/**
 * Uma secao numerada do documento.
 *
 * Conteudo e dado, nao JSX: as duas paginas legais descrevem o que dizem numa
 * estrutura tipada e este componente decide como isso vira tela. Foi o mesmo
 * caminho da pagina /ajuda, e ele se paga na hora de revisar o texto juridico
 * sem esbarrar em markup.
 */
export interface Secao {
  /** Vira a ancora da URL (`/privacidade#dados-coletados`) e a chave do React. */
  id: string;
  titulo: string;
  /** Cada string e um paragrafo. Texto puro — nada de markdown. */
  paragrafos: string[];
  /** Lista de definicoes, renderizada depois dos paragrafos. */
  lista?: ItemLista[];
  /** Paragrafos que fecham a secao, depois da lista. */
  fecho?: string[];
}

interface DocumentoLegalProps {
  titulo: string;
  /** Uma frase dizendo a quem o documento serve. Fica sob o titulo. */
  resumo: string;
  secoes: Secao[];
}

// ---------------------------------------------------------------------------
// Texto com marcador de campo pendente
// ---------------------------------------------------------------------------

/**
 * Escreve o paragrafo destacando os `[PREENCHER: ...]` que sobraram.
 *
 * Sem isso o marcador passa como texto comum e tem chance real de ir ao ar
 * dentro de uma clausula — que e exatamente o tipo de erro que so aparece
 * depois que alguem de fora leu.
 */
function Texto({ children }: { children: string }) {
  const partes = children.split(MARCADOR_PENDENTE);

  return (
    <>
      {partes.map((parte, i) =>
        parte.startsWith('[PREENCHER:') ? (
          <mark
            key={i}
            className="rounded px-1 font-medium"
            style={{ background: 'rgba(245, 158, 11, 0.22)', color: 'var(--warning)' }}
          >
            {parte}
          </mark>
        ) : (
          <Fragment key={i}>{parte}</Fragment>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

export function DocumentoLegal({ titulo, resumo, secoes }: DocumentoLegalProps) {
  const incompleto = !empresaCompleta();

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b pb-8" style={{ borderColor: 'var(--border-subtle)' }}>
        <h1
          className="text-3xl font-semibold tracking-tight sm:text-4xl"
          style={{ color: 'var(--text-primary)' }}
        >
          {titulo}
        </h1>
        <p className="mt-3 text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {resumo}
        </p>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          Última atualização: {ATUALIZADO_EM}
        </p>
      </header>

      {incompleto && (
        <div
          role="status"
          className="mb-10 rounded-lg border px-4 py-3 text-sm leading-relaxed"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.35)',
            background: 'rgba(245, 158, 11, 0.08)',
            color: 'var(--text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--warning)' }}>Documento em preparação.</strong>{' '}
          Os trechos destacados em amarelo ainda dependem dos dados cadastrais da empresa
          (<code>apps/web/src/lib/legal/empresa.ts</code>). Preencha-os antes de submeter estas
          URLs à análise da Meta ou de divulgá-las publicamente.
        </div>
      )}

      <nav aria-label="Sumário" className="mb-12">
        <h2
          className="mb-3 text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Nesta página
        </h2>
        <ol className="space-y-1.5">
          {secoes.map((secao, i) => (
            <li key={secao.id} className="text-sm">
              <a
                href={`#${secao.id}`}
                className="inline-flex gap-2 transition-colors hover:underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{i + 1}.</span>
                {secao.titulo}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-12">
        {secoes.map((secao, i) => (
          <section key={secao.id} id={secao.id} className="scroll-mt-24">
            <h2
              className="mb-4 text-xl font-semibold tracking-tight sm:text-2xl"
              style={{ color: 'var(--text-primary)' }}
            >
              <span className="mr-2 font-mono text-base" style={{ color: 'var(--text-muted)' }}>
                {i + 1}.
              </span>
              {secao.titulo}
            </h2>

            <div className="space-y-4">
              {secao.paragrafos.map((p, j) => (
                <p
                  key={j}
                  className="text-[15px] leading-7"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Texto>{p}</Texto>
                </p>
              ))}
            </div>

            {secao.lista && (
              <dl className={cn('mt-5 space-y-3.5')}>
                {secao.lista.map((item) => (
                  <div
                    key={item.termo}
                    className="rounded-lg border px-4 py-3"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--bg-surface-1)',
                    }}
                  >
                    <dt
                      className="text-sm font-semibold"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {item.termo}
                    </dt>
                    <dd
                      className="mt-1 text-[15px] leading-7"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <Texto>{item.texto}</Texto>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {secao.fecho && (
              <div className="mt-5 space-y-4">
                {secao.fecho.map((p, j) => (
                  <p
                    key={j}
                    className="text-[15px] leading-7"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <Texto>{p}</Texto>
                  </p>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </article>
  );
}
