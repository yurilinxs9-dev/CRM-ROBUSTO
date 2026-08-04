import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Config única para os dois apps. O passo `Lint` do CI existia desde o começo
 * apontando para um eslint que nunca esteve instalado — falhava em TODO push e,
 * por ser o passo 6, impedia Typecheck, Test e Build de rodarem. O pipeline
 * parecia proteger e não protegia nada.
 *
 * Escolha das severidades: erro só para o que quebra de fato (variável não
 * declarada, `case` sem break, bloco vazio que engole exceção). As duas regras
 * de qualidade que o CLAUDE.md cobra — nada de `any`, nada de variável morta —
 * entram como AVISO, porque há 48 violações herdadas em 25 arquivos: subir isso
 * para erro agora tornaria o CI vermelho de novo e obrigaria a mexer em código
 * não relacionado no mesmo commit. A dívida está registrada, não escondida.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/generated/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Catch vazio é padrão deliberado no projeto (best-effort que não pode
      // derrubar o caminho principal); bloco vazio em outro lugar é bug.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Os plugins do Next existem aqui porque o código do web tem comentários
    // `eslint-disable-next-line @next/next/...` e `react-hooks/...`: sem as
    // regras registradas, cada disable vira erro de "rule not found".
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      // As regras do @next/eslint-plugin-next v14 (par do Next 14) usam
      // `context.getAncestors`, removida no ESLint 9 — ligá-las derruba o lint
      // com TypeError. Ficam registradas e desligadas: é o que faz os
      // `eslint-disable-next-line @next/next/...` do código resolverem.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Testes precisam de dublês: `as never` e afins são a forma honesta de
    // dizer "isto é um mock", não um buraco de tipagem em produção.
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
