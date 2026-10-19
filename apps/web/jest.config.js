/** Pure helpers and server-rendered component/query regressions. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: 'lib/.*\\.spec\\.tsx?$',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
  },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
};
