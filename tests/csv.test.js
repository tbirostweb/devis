import test from 'node:test';
import assert from 'node:assert/strict';
import { csvSafe } from '../src/lib/format.js';

test('F6 : neutralisation des formules CSV sans casser les montants négatifs', () => {
    for (const v of ['=1+1', '+cmd', '-cmd|x', '@SUM(A1)', ' =x', '\t=x', '\r=x']) assert.equal(csvSafe(v), "'" + v);
    for (const v of ['-12.50', '12.50', '0.00', '-3', '12,5', 'Client', '2026-10-06', '']) assert.equal(csvSafe(v), v);
    assert.equal(csvSafe(null), '');
    assert.equal(csvSafe(-4.2), '-4.2');
});
