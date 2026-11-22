import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrect } from '../src/grade.js';

test('математическая запись ответов', () => {
  const ok = [['3,5', '3.5'], ['7/2', '3,5'], ['−3', '-3'], ['x = 5', '5'], ['-3; 2', '2; -3'], ['1/2', '0,5 | 1/2'],
    ['0.50', '1/2'], ['2a+3', '2a + 3'], ['3:4', '0,75'], ['  12 ', '12']];
  const bad = [['6', '5'], ['', '5'], ['2', '2; -3'], ['abc', '5'], ['1e3', '1000']];
  for (const [g, k] of ok) assert.equal(isCorrect(g, k), true, `${g} = ${k}`);
  for (const [g, k] of bad) assert.equal(isCorrect(g, k), false, `${g} ≠ ${k}`);
});
