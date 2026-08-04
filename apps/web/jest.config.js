/**
 * Só as funções puras de `src/lib` — não há runner de componente aqui, e o que
 * quebrou de verdade na tela de follow-up foi conta (previsão, limites), não
 * renderização.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: 'lib/.*\\.spec\\.ts$',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
};
