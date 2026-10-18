import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalize } from '../src/strings.js';

test('capitalize делает первую букву заглавной', () => {
  assert.equal(capitalize('hello'), 'Hello');
});

test('capitalize отказывает на нестроковом входе', () => {
  assert.throws(() => capitalize(42), TypeError);
});
