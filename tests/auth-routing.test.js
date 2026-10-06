import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import { db } from '../server/db.js';
import { auth, hasEncodedUnreserved, resetLoginFailures } from '../server/auth.js';
import { records } from '../server/routes/records.js';
import { abby } from '../server/routes/abby.js';
import { team } from '../server/routes/team.js';

// Aucun accès réseau ni base : les méthodes Prisma utilisées sont remplacées par des doubles en mémoire.
const ORIGIN = process.env.APP_ORIGIN || 'http://127.0.0.1:5184';
const csrf = randomBytes(32).toString('hex');
const sessions = new Map();
let handlerReached = 0;
const sessionFor = (token, user) => sessions.set(token, { csrf, expiresAt: new Date(Date.now() + 3600e3), user });
const { createHash } = await import('node:crypto');
const sha = (s) => createHash('sha256').update(s).digest('hex');
db.session.findUnique = async ({ where }) => { for (const [t, s] of sessions) if (sha(t) === where.id) return { id: where.id, ...s }; return null; };
db.session.findUniqueOrThrow = async ({ where }) => ({ id: where.id, csrf });
db.session.deleteMany = async () => ({ count: 0 });
db.session.create = async () => ({});
const password = 'mot-de-passe-de-test-tres-long';
const adminUser = { id: 'admin1', name: 'Admin', email: 'admin@example.test', role: 'admin', totpEnabled: false, referrerId: null, passwordHash: await argon2.hash(password) };
db.user.findUnique = async ({ where }) => (where.email === adminUser.email ? adminUser : null);
db.client.findMany = async () => { handlerReached++; return []; };
db.client.count = async () => 0;

async function build({ rewriteRawUrl } = {}) {
    const app = Fastify();
    await app.register(cookie);
    app.setErrorHandler((error, req, reply) => reply.code(error.statusCode ?? 500).send({ message: error.message }));
    // Simule un écart entre l'URL brute et la route trouvée (le routeur a déjà choisi la route).
    if (rewriteRawUrl) app.addHook('onRequest', async (req) => { req.raw.url = rewriteRawUrl(req.raw.url); });
    await auth(app);
    await records(app);
    await abby(app);
    await team(app);
    await app.ready();
    return app;
}
const app = await build();
test.after(() => app.close());

test('hasEncodedUnreserved détecte un caractère non réservé encodé', () => {
    assert.equal(hasEncodedUnreserved('/%61pi/clients'), true);
    assert.equal(hasEncodedUnreserved('/ap%69/settings'), true);
    assert.equal(hasEncodedUnreserved('/api/x%2Ey'), true);
    assert.equal(hasEncodedUnreserved('/api/clients'), false);
    assert.equal(hasEncodedUnreserved('/api/files/a%20b%2Fc'), false);
});

test('F1 : chemins encodés refusés sans session (jamais traités)', async () => {
    for (const [method, url] of [['GET', '/%61pi/clients'], ['GET', '/ap%69/settings'], ['POST', '/%61pi/invoices/x/abby/finalize']]) {
        const res = await app.inject({ method, url, headers: { origin: ORIGIN } });
        assert.ok([400, 401].includes(res.statusCode), `${method} ${url} -> ${res.statusCode}`);
    }
    assert.equal(handlerReached, 0);
});

test('F1 : chemins encodés refusés avec session admin sans 2FA ou session apporteur', async () => {
    sessionFor('tok-admin-no2fa', { id: 'a2', name: 'A', email: 'a@x.test', role: 'admin', totpEnabled: false, referrerId: null });
    sessionFor('tok-referrer', { id: 'r1', name: 'R', email: 'r@x.test', role: 'referrer', totpEnabled: false, referrerId: 'ref1' });
    for (const token of ['tok-admin-no2fa', 'tok-referrer']) {
        const res = await app.inject({ method: 'GET', url: '/%61pi/clients', cookies: { bw_session: token } });
        assert.ok([400, 403].includes(res.statusCode), `${token} -> ${res.statusCode}`);
        const plain = await app.inject({ method: 'GET', url: '/api/clients', cookies: { bw_session: token } });
        assert.equal(plain.statusCode, 403);
    }
    assert.equal(handlerReached, 0);
});

test('F1 : la décision suit la route trouvée, pas l’URL brute', async () => {
    const skew = await build({ rewriteRawUrl: (u) => u.replace(/^\/api\//, '/xpi/') });
    try {
        assert.equal((await skew.inject({ method: 'GET', url: '/api/clients' })).statusCode, 401);
        assert.equal((await skew.inject({ method: 'GET', url: '/api/settings' })).statusCode, 401);
        assert.equal((await skew.inject({ method: 'POST', url: '/api/invoices/x/abby/finalize', headers: { origin: ORIGIN } })).statusCode, 401);
        const ref = await skew.inject({ method: 'GET', url: '/api/clients', cookies: { bw_session: 'tok-referrer' } });
        assert.equal(ref.statusCode, 403);
        const adm = await skew.inject({ method: 'GET', url: '/api/clients', cookies: { bw_session: 'tok-admin-no2fa' } });
        assert.equal(adm.statusCode, 403);
    }
    finally { await skew.close(); }
    assert.equal(handlerReached, 0);
});

test('F1 : usages légitimes inchangés', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/clients' })).statusCode, 401);
    sessionFor('tok-admin', { id: 'a3', name: 'A', email: 'b@x.test', role: 'admin', totpEnabled: true, referrerId: null });
    const ok = await app.inject({ method: 'GET', url: '/api/clients?q=%61', cookies: { bw_session: 'tok-admin' } });
    assert.equal(ok.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { bw_session: 'tok-referrer' } });
    assert.equal(me.statusCode, 200);
    const enrol = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { bw_session: 'tok-admin-no2fa' } });
    assert.equal(enrol.statusCode, 200);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/categories', headers: { origin: ORIGIN }, cookies: { bw_session: 'tok-admin' }, payload: { name: 'x' } });
    assert.equal(noCsrf.statusCode, 403);
});

const login = (ip, pwd) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, headers: { origin: ORIGIN }, payload: { email: adminUser.email, password: pwd } });

test('F2 : 8 échecs depuis l’IP A n’empêchent pas une connexion correcte depuis l’IP B', async () => {
    resetLoginFailures();
    for (let i = 0; i < 8; i++) {
        const res = await login('10.0.0.1', 'mauvais-mot-de-passe');
        assert.ok([401, 429].includes(res.statusCode));
    }
    assert.equal((await login('10.0.0.1', password)).statusCode, 429, 'IP A temporisée');
    const res = await login('10.0.0.2', password);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.email, adminUser.email);
});

test('F2 : une connexion réussie n’est pas comptée comme un échec', async () => {
    resetLoginFailures();
    for (let i = 0; i < 10; i++) assert.equal((await login('10.0.0.3', password)).statusCode, 200);
});

test('F5 : PATCH /api/subscriptions/:id refuse un nextDate antérieur à l’échéance actuelle', async () => {
    const sub = { id: 's1', name: 'Hébergement', clientId: 'c1', nextDate: '2026-11-01', active: true };
    db.$transaction = async (work) => work(db);
    db.subscription.findUnique = async () => ({ ...sub });
    db.subscription.update = async ({ data }) => Object.assign(sub, data);
    db.activityLog.create = async () => ({});
    const patch = (payload) => app.inject({ method: 'PATCH', url: '/api/subscriptions/s1', headers: { origin: ORIGIN, 'x-csrf-token': csrf }, cookies: { bw_session: 'tok-admin' }, payload });
    assert.equal((await patch({ active: true, nextDate: '2026-10-01' })).statusCode, 400);
    assert.equal(sub.nextDate, '2026-11-01');
    assert.equal((await patch({ active: true, nextDate: '2026-11-01' })).statusCode, 200);
    assert.equal((await patch({ active: true, nextDate: '2026-12-01' })).statusCode, 200);
    assert.equal(sub.nextDate, '2026-12-01');
    // Usage de l'interface (arrêt/réactivation sans date) inchangé.
    assert.equal((await patch({ active: false })).statusCode, 200);
    assert.equal(sub.active, false);
});
