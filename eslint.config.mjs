// Lint (no build, no dependencies in the app): npm install --no-save eslint@9 globals && npx eslint .
// Catches what tests may miss: names that are not defined, variables and imports that are not used, unreachable code.
import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-loss-of-precision': 'error',
  'no-shadow-restricted-names': 'error',
  'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-catch': 'error',
};

export default [
  { ignores: ['vendor/**', '_site/**', 'node_modules/**', 'mcp/skill/**', 'mcp/docs/**'] },
  // the app: classic scripts on window.ME (index.html), so a page opened from the disk works
  { files: ['js/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } }, rules },
  // the MCP server, the tests and this file: Node.js modules
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } }, rules },
];
