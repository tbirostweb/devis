import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, verifyTotp } from '../server/totp.js';
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
test('base32 round-trips arbitrary bytes', () => {
    for (const s of ['', 'A', 'foobar', '12345678901234567890']) assert.equal(base32Decode(base32Encode(Buffer.from(s))).toString(), s);
});
test('TOTP matches RFC 6238 SHA-1 test vectors (6 digits)', () => {
    // T=59s -> HOTP counter 1 -> 287082 ; T=1111111109 -> 081804
    assert.ok(verifyTotp(rfcSecret, '287082', 59 * 1000, 0));
    assert.ok(verifyTotp(rfcSecret, '081804', 1111111109 * 1000, 0));
    assert.ok(!verifyTotp(rfcSecret, '000000', 59 * 1000, 0));
});
test('TOTP tolerates ±1 step and rejects malformed input', () => {
    assert.ok(verifyTotp(rfcSecret, '287082', (59 + 30) * 1000, 1));
    assert.ok(!verifyTotp(rfcSecret, '287082', (59 + 120) * 1000, 1));
    for (const bad of ['', '12', '1234567', 'abcdef', null, undefined]) assert.ok(!verifyTotp(rfcSecret, bad, 59 * 1000));
    assert.ok(!verifyTotp('', '287082'));
});
