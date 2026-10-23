import { fixupConfigRules } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import * as espree from 'espree';

// Curated runtime globals for `no-undef` (below). The `globals` package is not
// a direct dependency in this pnpm layout, so the union of browser + node
// globals this repo actually uses is listed here. Extend when code adopts a
// new platform global — lint will name it.
const RUNTIME_GLOBALS = {
  // Shared
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  // Browser
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  indexedDB: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  WebSocket: 'readonly',
  FormData: 'readonly',
  File: 'readonly',
  Blob: 'readonly',
  FileReader: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  DOMParser: 'readonly',
  Image: 'readonly',
  AudioContext: 'readonly',
  MediaRecorder: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  // Node
  process: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

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
      // eslint-config-next leaves no-undef off (it assumes TypeScript); this
      // repo is plain JS, and an undeclared identifier in a hook shipped a
      // broken chat (settleModelSwitchRef, 2026-10-21). Browser + node
      // globals are declared explicitly below so plain JS lints clean.
      'no-undef': 'error',
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      globals: RUNTIME_GLOBALS,
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'node_modules/**',
    'public/sw.js', // generated Workbox bundle (minified, own build)
  ]),
]);

export default eslintConfig;
