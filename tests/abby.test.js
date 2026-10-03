import test from 'node:test';
import assert from 'node:assert/strict';
import { createAbbyHttp, AbbyError } from '../server/services/abby/http.js';
import { createAbbyService, buildAbbyLines, vatCodeFor, vatMentionFor, readInvoiceSync, assertFinalizable } from '../server/services/abby/service.js';
import { createMockFetch } from '../server/services/abby/mock.js';

const line = (extra = {}) => ({ id: 'q1', name: 'Site vitrine', description: 'desc', quantityMilli: 2000, unitCents: 99900, vatBps: 0, discountBps: 0, optional: false, selected: true, ...extra });

test('vatCodeFor maps basis points and forces HT in franchise', () => {
    assert.equal(vatCodeFor(0, false), 'FR_00HT');
    assert.equal(vatCodeFor(2000, false), 'FR_00HT'); // vatEnabled=false => toujours HT
    assert.equal(vatCodeFor(2000, true), 'FR_2000');
    assert.equal(vatCodeFor(1000, true), 'FR_1000');
    assert.equal(vatCodeFor(850, true), 'FR_850');
    assert.equal(vatCodeFor(550, true), 'FR_550');
    assert.equal(vatCodeFor(210, true), 'FR_210');
    assert.equal(vatCodeFor(1234, true), 'FR_00HT'); // taux inconnu => repli HT
});

test('vatMentionFor exposes exemption only when VAT disabled', () => {
    assert.equal(vatMentionFor({ vatEnabled: false }), 'vat_not_applicable');
    assert.equal(vatMentionFor({ vatEnabled: false, vatMention: 'vat_exemption' }), 'vat_exemption');
    assert.equal(vatMentionFor({ vatEnabled: true }), undefined);
});

test('buildAbbyLines maps quantity/price, applies HT and filters unselected options', () => {
    const lines = buildAbbyLines([line(), line({ id: 'q2', discountBps: 1000 }), line({ id: 'opt', optional: true, selected: false })], { vatEnabled: false });
    assert.equal(lines.length, 2); // l'option non retenue est exclue
    assert.equal(lines[0].quantity, 2); // quantityMilli/1000
    assert.equal(lines[0].unitPrice, 99900); // centimes inchangés
    assert.equal(lines[0].vatCode, 'FR_00HT');
    assert.equal(lines[0].isTaxIncluded, false);
    assert.equal(lines[0].discount, undefined);
    assert.deepEqual(lines[1].discount, { mode: 'PERCENTAGE', amount: 1000 });
});

test('ensureOrganization is idempotent and never duplicates', async () => {
    const calls = [];
    const http = { post: async (p, b) => { calls.push([p, b]); return { id: 'org_new' }; } };
    const svc = createAbbyService(http);
    const existing = await svc.ensureOrganization({ abbyClientId: 'org_known', name: 'X' });
    assert.deepEqual(existing, { id: 'org_known', created: false });
    assert.equal(calls.length, 0); // aucun appel réseau quand l'id est déjà connu
    const created = await svc.ensureOrganization({ name: 'ACME', email: 'a@b.c', siret: '12345678901234' });
    assert.deepEqual(created, { id: 'org_new', created: true });
    assert.equal(calls[0][0], '/organization');
    assert.deepEqual(calls[0][1], { name: 'ACME', emails: ['a@b.c'], siret: '12345678901234' });
});

test('service builds correct paths and bodies', async () => {
    const seen = [];
    const http = {
        post: async (p, b) => { seen.push(['POST', p, b]); return { id: 'inv_1', state: 'draft', test: true }; },
        patch: async (p, b) => { seen.push(['PATCH', p, b]); return { id: 'inv_1', state: 'draft' }; },
        get: async (p, o) => { seen.push(['GET', p, o]); return Buffer.from('%PDF-'); },
    };
    const svc = createAbbyService(http);
    await svc.createDraftInvoice('cust 1');
    await svc.setInvoiceLines('inv_1', [{ designation: 'x' }], { mode: 'PERCENTAGE', amount: 500 });
    await svc.setGeneralInfo('inv_1', { vatMention: 'vat_not_applicable' });
    await svc.finalizeInvoice('inv_1');
    await svc.markPaid('inv_1', [{ amount: 100, receivedAt: '2026-01-01', method: 'transfer' }]);
    await svc.downloadInvoicePdf('inv_1');
    assert.equal(seen[0][1], '/v2/billing/invoice/cust%201'); // customerId encodé
    assert.equal(seen[1][1], '/v2/billing/inv_1/lines');
    assert.deepEqual(seen[1][2], { lines: [{ designation: 'x' }], discount: { mode: 'PERCENTAGE', amount: 500 } });
    assert.equal(seen[2][1], '/v2/billing/invoice/inv_1/general-informations');
    assert.equal(seen[3][1], '/v2/billing/inv_1/finalize');
    assert.equal(seen[4][1], '/v2/accounting-billing/invoice/inv_1/reconciliate');
    assert.equal(seen[5][1], '/v2/billing/inv_1/download');
});

test('getInvoice paginates billings and finds by id', async () => {
    let page = 0;
    const http = { get: async (p, o) => { page = o.query.page; return page === 1 ? { billings: [{ id: 'a' }, { id: 'b' }] } : { billings: [] }; } };
    const svc = createAbbyService(http);
    assert.deepEqual(await svc.getInvoice('b', { test: false }), { id: 'b' });
    assert.equal(await svc.getInvoice('zzz', { test: false }), null);
});

test('assertFinalizable blocks non-test documents unless live finalize enabled', () => {
    assert.throws(() => assertFinalizable({ test: false }), /mode test/);
    assert.throws(() => assertFinalizable({ test: null }), /mode test/);
    assert.doesNotThrow(() => assertFinalizable({ test: true }));
    process.env.ABBY_ALLOW_LIVE_FINALIZE = 'true';
    try { assert.doesNotThrow(() => assertFinalizable({ test: false })); }
    finally { delete process.env.ABBY_ALLOW_LIVE_FINALIZE; }
});

test('readInvoiceSync extracts number/state/test', () => {
    assert.deepEqual(readInvoiceSync({ id: 'i', number: 'F-1', state: 'finalized', test: true }), { abbyInvoiceId: 'i', abbyNumber: 'F-1', abbyStatus: 'finalized', abbyTest: true });
});

// --- Couche HTTP : auth, erreurs, retries idempotents uniquement ---

function fakeResponse(status, body, { pdf = false } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => (pdf ? 'application/pdf' : 'application/json') },
        json: async () => body,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer,
    };
}

test('http requires an API key', () => {
    assert.throws(() => createAbbyHttp({ apiKey: '', fetch: async () => {} }), /Clé API/);
});

test('http sends Bearer auth and parses JSON', async () => {
    let authHeader;
    const http = createAbbyHttp({ apiKey: 'suk-secret', fetch: async (_u, o) => { authHeader = o.headers.Authorization; return fakeResponse(200, { ok: 1 }); } });
    assert.deepEqual(await http.get('/x'), { ok: 1 });
    assert.equal(authHeader, 'Bearer suk-secret');
});

test('http maps 401 without retry', async () => {
    let calls = 0;
    const http = createAbbyHttp({ apiKey: 'k', retryDelayMs: 1, fetch: async () => { calls++; return fakeResponse(401, { message: 'nope' }); } });
    await assert.rejects(() => http.get('/x'), (e) => e instanceof AbbyError && e.status === 401);
    assert.equal(calls, 1); // 401 n'est pas ré-essayé
});

test('http retries idempotent GET on 429 then fails', async () => {
    let calls = 0;
    const http = createAbbyHttp({ apiKey: 'k', retries: 2, retryDelayMs: 1, fetch: async () => { calls++; return fakeResponse(429, { message: 'slow down' }); } });
    await assert.rejects(() => http.get('/x'), (e) => e.status === 429);
    assert.equal(calls, 3); // 1 + 2 retries
});

test('http does NOT retry non-idempotent POST', async () => {
    let calls = 0;
    const http = createAbbyHttp({ apiKey: 'k', retries: 3, retryDelayMs: 1, fetch: async () => { calls++; throw new Error('network down'); } });
    await assert.rejects(() => http.post('/x', {}), (e) => e instanceof AbbyError && e.status === 0);
    assert.equal(calls, 1); // POST non ré-essayé
});

test('http retries idempotent GET on network error', async () => {
    let calls = 0;
    const http = createAbbyHttp({ apiKey: 'k', retries: 2, retryDelayMs: 1, fetch: async () => { calls++; throw new Error('ECONNRESET'); } });
    await assert.rejects(() => http.get('/x'), (e) => e.status === 0);
    assert.equal(calls, 3);
});

test('http returns a Buffer for PDF downloads', async () => {
    const http = createAbbyHttp({ apiKey: 'k', fetch: async () => fakeResponse(200, '%PDF-1.4', { pdf: true }) });
    const buf = await http.get('/v2/billing/x/download', { expect: 'pdf' });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});

// --- Mock complet en mémoire (happy path), réutilisé par l'e2e ---

test('mock simulates the full billing lifecycle with test=true', async () => {
    const http = createAbbyHttp({ apiKey: 'suk-mock', fetch: createMockFetch() });
    const svc = createAbbyService(http);
    const org = await svc.ensureOrganization({ name: 'Mock SARL', email: 'm@x.fr' });
    const draft = await svc.createDraftInvoice(org.id);
    assert.equal(draft.state, 'draft');
    assert.equal(draft.test, true); // jamais une vraie facture légale
    assert.equal(draft.number, null);
    await svc.setInvoiceLines(draft.id, buildAbbyLines([line()], { vatEnabled: false }));
    await svc.setGeneralInfo(draft.id, { vatMention: 'vat_not_applicable' });
    const final = await svc.finalizeInvoice(draft.id);
    assert.equal(final.state, 'finalized');
    assert.match(final.number, /^F-\d{4}-\d{4}$/);
    const pdf = await svc.downloadInvoicePdf(draft.id);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const paid = await svc.markPaid(draft.id, [{ amount: 100, receivedAt: '2026-01-01', method: 'transfer' }]);
    assert.equal(paid.state, 'paid');
    const found = await svc.getInvoice(draft.id, { customerId: org.id, test: false });
    assert.equal(found.id, draft.id);
});

test('mock rejects editing a finalized invoice and missing auth', async () => {
    const fetchImpl = createMockFetch();
    const http = createAbbyHttp({ apiKey: 'suk-mock', fetch: fetchImpl });
    const svc = createAbbyService(http);
    const draft = await svc.createDraftInvoice('cust');
    await svc.finalizeInvoice(draft.id);
    await assert.rejects(() => svc.setInvoiceLines(draft.id, []), (e) => e.status === 409);
    // sans Bearer => 401
    const res = await fetchImpl('https://api.app-abby.com/organization', { method: 'POST', headers: {}, body: '{}' });
    assert.equal(res.status, 401);
});
