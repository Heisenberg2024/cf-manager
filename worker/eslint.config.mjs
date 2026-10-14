import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { commonRules, ignores } from '../eslint.shared.mjs';

export default [
  { ignores: [...ignores, 'scheduler-dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  commonRules,
];
