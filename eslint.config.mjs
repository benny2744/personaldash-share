import { fixupConfigRules } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import * as espree from 'espree';

const eslintConfig = defineConfig([
  ...fixupConfigRules(nextVitals),
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      parser: espree,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  {
    rules: {
      // Existing client components intentionally hydrate UI state from effects.
      // Refactor these patterns separately before enabling the React Compiler rules.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'node_modules/**',
  ]),
]);

export default eslintConfig;
