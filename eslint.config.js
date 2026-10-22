// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Seeded randomness only (ADR 0008): engine and node code. */
const noMathRandom = {
  'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'Use the seeded RNG from @flow-patcher/engine (randomAt / createRng).' }],
};
/** The other unseeded source, Web Crypto (getRandomValues, randomUUID); goes in each no-restricted-globals list. */
const noCrypto = { name: 'crypto', message: 'Unseeded randomness: use the seeded RNG from @flow-patcher/engine (randomAt / createRng).' };

/** The engine runs without a DOM, React or Node (design.md, Technical architecture; ADR 0013). */
export const engineBoundary = {
  'no-restricted-imports': ['error', {
    patterns: [
      { group: ['react', 'react/*', 'react-dom', 'react-dom/*', '@xyflow/*', 'zustand', 'zustand/*'], message: 'packages/engine has no React or editor imports.' },
      { group: ['@flow-patcher/nodes', '@flow-patcher/nodes/*', '@flow-patcher/editor', '@flow-patcher/editor/*'], message: 'packages/engine must not depend on nodes or editor.' },
      { group: ['node:*', 'fs', 'path', 'os', 'url', 'crypto', 'child_process', 'worker_threads'], message: 'packages/engine has no Node imports; it must run in the browser too.' },
      { group: ['**/spike/**'], message: 'Nothing in packages/ imports from spike/.' },
    ],
  }],
  'no-restricted-globals': ['error',
    ...['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'EventTarget', 'requestAnimationFrame', 'cancelAnimationFrame', 'AudioContext', 'OfflineAudioContext', 'process', 'require', 'Buffer', '__dirname']
      .map((name) => ({ name, message: `packages/engine has no DOM or Node globals (${name}). Inject what you need.` })),
    noCrypto,
  ],
};

/** Node code is pure window queries: no timers (ADR 0008). */
const nodeRules = {
  'no-restricted-globals': ['error',
    ...['setTimeout', 'setInterval', 'requestAnimationFrame', 'window', 'document'].map((name) => ({ name, message: `Nodes never own timers or touch the DOM (${name}); the engine drives query()/frame().` })),
    noCrypto,
  ],
  'no-restricted-imports': ['error', {
    patterns: [
      { group: ['react', 'react/*', 'react-dom', '@xyflow/*', '@flow-patcher/editor'], message: 'Nodes must not depend on the editor.' },
      { group: ['**/spike/**'], message: 'Nothing in packages/ imports from spike/.' },
    ],
  }],
};

export default defineConfig(
  { ignores: ['**/node_modules/', '**/dist/', 'out/', 'test-results/', 'playwright-report/', 'spike/', '.claude/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: { ...noMathRandom, ...engineBoundary },
  },
  {
    files: ['packages/nodes/src/**/*.ts'],
    rules: { ...noMathRandom, ...nodeRules },
  },
  {
    files: ['packages/editor/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/spike/**'], message: 'Nothing in packages/ imports from spike/.' }] }],
    },
  },
  {
    files: ['tools/**/*.ts', 'test-support/**/*.ts', 'e2e/**/*.ts', 'packages/*/test/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
);
