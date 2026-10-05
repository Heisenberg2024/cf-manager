import { describe, it, expect } from 'vitest';
import { baseCompile } from '@intlify/message-compiler';
import zh from '../src/i18n/locales/zh-CN.json';
import en from '../src/i18n/locales/en.json';
function strings(object: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  return Object.entries(object).flatMap(([key, value]) => typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : strings(value as Record<string, unknown>, `${prefix}${key}.`));
}
describe('translated UI does not disappear because of message compilation errors', () => {
  for (const [locale, messages] of [['zh-CN', zh], ['en', en]] as const) {
    it(`compiles ${locale} messages, including apex Host hints`, () => {
      for (const [key, message] of strings(messages)) {
        const errors: unknown[] = [];
        baseCompile(message, { onError: error => errors.push(error) });
        expect(errors, `${locale}.${key}`).toEqual([]);
      }
    });
  }
});
