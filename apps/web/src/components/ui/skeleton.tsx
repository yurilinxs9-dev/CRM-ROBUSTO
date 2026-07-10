import { cn } from '@/lib/cn';

/**
 * Skeleton padrão (Onda 2): shimmer sutil em vez de pulse chapado — lê como
 * "carregando conteúdo", não como "bloco cinza". Usar sempre com o MESMO
 * raio/tamanho do conteúdo real que vai substituir.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-muted',
        'after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.6s_infinite]',
        'after:bg-gradient-to-r after:from-transparent after:via-white/[0.06] after:to-transparent',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
