import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleRetention } from '../server/retention.js';

test('retention does not touch storage or start a timer without explicit authorization', () => {
    const previous = process.env.RETENTION_ENABLED;
    const originalTimer = globalThis.setInterval;
    let storageCalls = 0;
    let timers = 0;
    const db = { $transaction() { storageCalls++; throw new Error('unexpected purge'); } };
    globalThis.setInterval = () => { timers++; throw new Error('unexpected timer'); };
    try {
        delete process.env.RETENTION_ENABLED;
        for (const value of [undefined, 'false', '1', 'TRUE', '']) {
            const stop = scheduleRetention(db, { error() {} }, value);
            assert.equal(typeof stop, 'function');
            stop();
        }
        assert.equal(storageCalls, 0);
        assert.equal(timers, 0);
    } finally {
        globalThis.setInterval = originalTimer;
        if (previous === undefined) delete process.env.RETENTION_ENABLED;
        else process.env.RETENTION_ENABLED = previous;
    }
});
