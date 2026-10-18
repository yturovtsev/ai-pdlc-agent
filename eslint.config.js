// Гейт lint конвейера (tools/agentflow/run.sh lint). Роли не могут менять этот файл.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.agentflow-runs/', 'tools/', 'openspec/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
