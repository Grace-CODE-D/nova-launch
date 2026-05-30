import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en.json';
import ha from '../../i18n/locales/ha.json';
import es from '../../i18n/locales/es.json';
import fr from '../../i18n/locales/fr.json';
import pt from '../../i18n/locales/pt.json';
import sw from '../../i18n/locales/sw.json';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return flattenKeys(value as Record<string, unknown>, fullKey);
    }
    return fullKey;
  });
}

describe('i18n locale key completeness', () => {
  const enKeys = flattenKeys(en).sort();

  const locales: Record<string, Record<string, unknown>> = { ha, es, fr, pt, sw };

  for (const [code, translations] of Object.entries(locales)) {
    it(`${code}.json has all keys present in en.json`, () => {
      const localeKeys = flattenKeys(translations).sort();
      const missingKeys = enKeys.filter(k => !localeKeys.includes(k));
      expect(missingKeys, `${code}.json is missing keys: ${missingKeys.join(', ')}`).toEqual([]);
    });

    it(`${code}.json has no extra keys not in en.json`, () => {
      const localeKeys = flattenKeys(translations).sort();
      const extraKeys = localeKeys.filter(k => !enKeys.includes(k));
      expect(extraKeys, `${code}.json has extra keys not in en.json: ${extraKeys.join(', ')}`).toEqual([]);
    });
  }
});
