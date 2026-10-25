// Guards the French dictionary.
//
// The key IS the Chinese original text, so a mistyped key does not fail any
// build — t() simply falls back to English and the translation is silently
// lost. Pin the two mistakes a copy-paste translation actually produces:
// a key that exists in no other dictionary, and a value that drops or renames
// a {placeholder} the original carries.
// npx tsx src/i18n/dict/fr/fr.verify.ts
import assert from 'node:assert/strict';

import { EN } from '../en';
import { FR } from './index';

const CJK = /[\u3400-\u9fff]/;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

let checked = 0;
for (const [key, value] of Object.entries(FR)) {
  assert.ok(key in EN, `fr key is not in the English dictionary (typo in the key?): ${key}`);
  assert.ok(value.trim().length > 0, `empty French value for: ${key}`);
  assert.ok(!CJK.test(value), `French value still contains Chinese characters: ${key}`);
  assert.deepEqual(
    placeholders(value),
    placeholders(key),
    `placeholders changed in the French value of: ${key}`,
  );
  checked += 1;
}

assert.ok(checked > 0, 'the French dictionary must not be empty');

console.log(`fr.verify: ${checked} French entries use a real key and keep their placeholders`);
