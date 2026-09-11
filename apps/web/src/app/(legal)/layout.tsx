import Link from 'next/link';

import { EMPRESA } from '@/lib/legal/empresa';

/**
 * Casca das paginas juridicas publicas (/privacidade e /termos).
 *
 * Existe separada do `(dashboard)` de proposito: aquele layout monta sidebar,
 * store de auth e socket, e redireciona quem nao esta logado. Estas duas
 * paginas precisam do oposto — abrir para qualquer um, inclusive para o
 * rastreador da Meta durante o App Review, que chega sem sessao nenhuma e
 * desiste se cair num redirect de login.
 *
 * Sem 'use client' em lugar nenhum da arvore: o HTML sai pronto do servidor,
 * que e o que um revisor (humano ou robo) consegue ler.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: 'var(--bg-base)' }}>
      <header
        className="border-b"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface-1)' }}
      >
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-4 sm:px-8">
          <Link
            href="/"
            className="text-sm font-semibold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            {EMPRESA.nomeProduto}
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            <Link
              href="/privacidade"
              className="transition-colors hover:underline"
              style={{ color: 'var(--text-secondary)' }}
            >
              Privacidade
            </Link>
            <Link
              href="/termos"
              className="transition-colors hover:underline"
              style={{ color: 'var(--text-secondary)' }}
            >
              Termos
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer
        className="border-t"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface-1)' }}
      >
        <div
          className="mx-auto w-full max-w-3xl px-5 py-6 text-sm sm:px-8"
          style={{ color: 'var(--text-muted)' }}
        >
          <p>
            {EMPRESA.nomeProduto} — plataforma de gestão de atendimento e vendas por WhatsApp.
          </p>
          <p className="mt-1">
            Este produto usa serviços da Meta Platforms e não é endossado nem certificado por ela.
            WhatsApp é marca registrada da Meta Platforms, Inc.
          </p>
        </div>
      </footer>
    </div>
  );
}
