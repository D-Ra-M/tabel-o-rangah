const globals = require('globals');

const shared = {
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-redeclare': 'error',
    'eqeqeq': ['warn', 'smart'],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error'
  }
};

module.exports = [
  { ignores: ['node_modules/**', 'vendor/**', 'test-results/**'] },
  {
    files: ['js/**/*.js', 'vendor/heic/convert.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, Sortable: 'readonly', module: 'readonly' } },
    ...shared
  },
  {
    files: ['service-worker.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker } },
    ...shared
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
    ...shared
  }
];
