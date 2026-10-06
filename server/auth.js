import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { db, HttpError } from './db.js';
import { generateSecret, matchTotpCounter, otpauthURL } from './totp.js';
import { sealSecret, openSecret, isSealed, totpKey } from './secrets.js';
import { isPwned } from './pwned.js';
import { profileSchema, emailChangeSchema } from '../shared/contracts.js';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const prod = process.env.NODE_ENV === 'production';
const cookieName = prod ? '__Host-bw_session' : 'bw_session';
const cookieOptions = { httpOnly: true, secure: prod, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12 };
const totpToken = z.string().regex(/^\d{6}$/, 'Code à 6 chiffres attendu.');
// Code de secours : 10 caractères base32 (affichés XXXXX-XXXXX), ~50 bits d'entropie, usage unique.
const recoveryCode = z.string().trim().max(32).transform(s => s.toUpperCase().replace(/[^A-Z2-7]/g, '')).pipe(z.string().length(10, 'Code de secours invalide.'));
const loginSchema = z.object({ email: z.email().transform(s => s.toLowerCase()), password: z.string().min(1).max(256), token: totpToken.optional(), recoveryCode: recoveryCode.optional() });
// Échecs de connexion : seuls les échecs sont comptés, par couple (email + IP), avec un délai progressif
// (et non un blocage dur) ; un plafond distinct par email, plus élevé, freine les attaques distribuées
// sans permettre à un tiers de bloquer durablement le compte depuis une autre adresse.
const loginFailures = new Map();
const LOGIN_FREE_FAILURES = 5, LOGIN_EMAIL_FREE_FAILURES = 50, LOGIN_MAX_DELAY_MS = 15 * 60 * 1000, LOGIN_EMAIL_MAX_DELAY_MS = 60 * 1000, LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_ENTRIES = 10000;
function loginKeys(email, ip) { return { pair: 'p:' + hash(email + '|' + (ip || '')), email: 'e:' + hash(email) }; }
function loginDelay(entry, free, max) { return entry.count < free ? 0 : Math.min(max, 1000 * 2 ** Math.min(20, entry.count - free)); }
function checkLoginDelay(keys, now = Date.now()) {
    for (const [k, v] of loginFailures) if (v.last + LOGIN_WINDOW_MS < now) loginFailures.delete(k); else break;
    const pair = loginFailures.get(keys.pair), byEmail = loginFailures.get(keys.email);
    const until = Math.max(pair ? pair.last + loginDelay(pair, LOGIN_FREE_FAILURES, LOGIN_MAX_DELAY_MS) : 0, byEmail ? byEmail.last + loginDelay(byEmail, LOGIN_EMAIL_FREE_FAILURES, LOGIN_EMAIL_MAX_DELAY_MS) : 0);
    if (until > now)
        throw new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil((until - now) / 1000)} s.`);
}
function recordLoginFailure(keys, now = Date.now()) {
    for (const key of [keys.pair, keys.email]) {
        const entry = loginFailures.get(key) ?? { count: 0, last: now };
        entry.count++; entry.last = now;
        // Réinsertion en fin de Map : l'ordre reste celui du dernier échec (purge et éviction des plus anciens).
        loginFailures.delete(key); loginFailures.set(key, entry);
    }
    while (loginFailures.size > LOGIN_MAX_ENTRIES) loginFailures.delete(loginFailures.keys().next().value);
}
export function resetLoginFailures() { loginFailures.clear(); }
// Routes accessibles sans session. Webhook Cal.com : authentifié par signature HMAC (voir routes/calendar.js), hors session + CSRF.
const PUBLIC_PATHS = new Set(['/api/health', '/api/webhooks/cal-com']);
function isPublicPath(path) { return !path.startsWith('/api/') || PUBLIC_PATHS.has(path); }
// Chemin de la route trouvée par le routeur (motif, ex. /api/clients/:id). Sans route (404),
// on retombe sur le chemin décodé pour rester fail-closed sur /api.
function routePath(req) {
    const url = req.routeOptions?.url;
    if (url) return url;
    const raw = req.url.split('?')[0];
    try { return decodeURIComponent(raw); } catch { return raw; }
}
export function hasEncodedUnreserved(path) {
    for (const m of path.matchAll(/%([0-9a-fA-F]{2})/g))
        if (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(parseInt(m[1], 16)))) return true;
    return false;
}
// Quota par utilisateur (et non par IP) pour les opérations sensibles du compte : évalué après l'authentification.
export const perUserLimit = { rateLimit: { max: 5, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req) => 'user:' + (req.user?.id ?? req.ip) } };
// Chemins accessibles à un administrateur qui n'a pas encore activé la double authentification.
const ENROLLMENT_PATHS = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/password', '/api/auth/profile', '/api/auth/2fa/setup', '/api/auth/2fa/enable']);
const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function checkOrigin(req) {
    const origin = req.headers.origin;
    const expected = process.env.APP_ORIGIN || 'http://127.0.0.1:5184';
    const allowed = [expected];
    if (!origin || !allowed.includes(origin))
        throw new HttpError(403, 'Origine de la requête refusée.');
}
export function newRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () => {
        const bytes = randomBytes(10);
        const raw = Array.from(bytes, b => RECOVERY_ALPHABET[b & 31]).join('');
        return raw.slice(0, 5) + '-' + raw.slice(5);
    });
}
export const recoveryHash = (code) => hash('recovery:' + code.toUpperCase().replace(/[^A-Z2-7]/g, ''));
// Vérifie un code TOTP ET consomme atomiquement son pas : un code (ou un code plus ancien) ne sert qu'une fois,
// y compris en cas de requêtes concurrentes (UPDATE conditionnel, une seule ligne modifiée gagne).
export async function consumeTotp(user, token, client = db) {
    const secret = openSecret(user.totpSecret);
    const counter = matchTotpCounter(secret, token);
    if (counter === null) return false;
    const claimed = await client.user.updateMany({ where: { id: user.id, OR: [{ totpLastCounter: null }, { totpLastCounter: { lt: counter } }] }, data: { totpLastCounter: counter } });
    if (claimed.count !== 1) return false;
    // Migration douce : un secret hérité stocké en clair est rechiffré dès son premier usage réussi.
    if (user.totpSecret && !isSealed(user.totpSecret) && totpKey())
        await client.user.update({ where: { id: user.id }, data: { totpSecret: sealSecret(secret) } });
    return true;
}
async function consumeRecoveryCode(userId, code) {
    const used = await db.totpRecoveryCode.updateMany({ where: { userId, codeHash: recoveryHash(code), usedAt: null }, data: { usedAt: new Date() } });
    return used.count === 1;
}
async function replaceRecoveryCodes(tx, userId) {
    const codes = newRecoveryCodes();
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await tx.totpRecoveryCode.createMany({ data: codes.map(c => ({ userId, codeHash: recoveryHash(c) })) });
    return codes;
}
async function verifyPassword(user, password, message = 'Mot de passe incorrect.') {
    if (!await argon2.verify(user.passwordHash, password))
        throw new HttpError(400, message);
}
export async function auth(app) {
    // Constant-cost verification for unknown accounts too.
    const dummyHash = await argon2.hash(randomBytes(32), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    app.decorateRequest('user', null);
    app.decorateRequest('sessionId', '');
    app.addHook('onRequest', async (req) => {
        const rawPath = req.url.split('?')[0];
        // Un caractère non réservé n'a jamais besoin d'être encodé : sa présence signale une tentative
        // de contournement (ex. /%61pi/... décodé en /api/... par le routeur).
        if (hasEncodedUnreserved(rawPath))
            throw new HttpError(400, 'Chemin de requête invalide.');
        // Décision prise sur la route effectivement trouvée par le routeur (et non sur l'URL brute).
        const path = routePath(req);
        if (isPublicPath(path))
            return;
        if (path === '/api/auth/login') {
            checkOrigin(req);
            return;
        }
        const token = req.cookies[cookieName];
        if (!token)
            throw new HttpError(401, 'Connectez-vous pour accéder au studio.');
        const session = await db.session.findUnique({ where: { id: hash(token) }, include: { user: true } });
        if (!session || session.expiresAt <= new Date())
            throw new HttpError(401, 'Votre session a expiré.');
        req.user = { id: session.user.id, name: session.user.name, email: session.user.email, totpEnabled: session.user.totpEnabled, role: session.user.role, referrerId: session.user.referrerId };
        req.sessionId = session.id;
        // Default-deny : un compte non administrateur n'atteint que son espace et son compte.
        if (req.user.role !== 'admin') {
            const self = path === '/api/auth/me' || path === '/api/auth/logout' || path === '/api/auth/password' || path === '/api/auth/email' || path === '/api/auth/profile' || path.startsWith('/api/auth/2fa/');
            if (!self && !path.startsWith('/api/portal'))
                throw new HttpError(403, 'Accès réservé à l’administrateur.');
        }
        // Double authentification obligatoire pour les administrateurs : tant qu'elle n'est pas activée,
        // la session ne donne accès qu'à l'enrôlement (aucune donnée métier).
        else if (!req.user.totpEnabled && !ENROLLMENT_PATHS.has(path))
            throw new HttpError(403, 'Activez la double authentification pour accéder au studio.', 'TOTP_ENROLLMENT_REQUIRED');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            checkOrigin(req);
            const provided = req.headers['x-csrf-token'];
            if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(session.csrf)))
                throw new HttpError(403, 'Jeton de sécurité invalide. Rechargez la page.');
        }
    });
    // Garde-fou fail-closed : aucune route /api non publique n'atteint son handler sans session.
    app.addHook('preHandler', async (req) => {
        const path = routePath(req);
        if (!isPublicPath(path) && path !== '/api/auth/login' && !req.user)
            throw new HttpError(401, 'Connectez-vous pour accéder au studio.');
    });
    app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const body = loginSchema.parse(req.body);
        const keys = loginKeys(body.email, req.ip);
        checkLoginDelay(keys);
        const user = await db.user.findUnique({ where: { email: body.email } });
        const valid = await argon2.verify(user?.passwordHash ?? dummyHash, body.password);
        if (!user || !valid) {
            recordLoginFailure(keys);
            throw new HttpError(401, 'Email ou mot de passe incorrect.');
        }
        if (user.totpEnabled) {
            if (body.recoveryCode) {
                if (!await consumeRecoveryCode(user.id, body.recoveryCode)) {
                    recordLoginFailure(keys);
                    return { twoFactor: true, error: 'Code de secours incorrect ou déjà utilisé.' };
                }
            }
            else {
                if (!body.token)
                    return { twoFactor: true };
                if (!await consumeTotp(user, body.token)) {
                    recordLoginFailure(keys);
                    return { twoFactor: true, error: 'Code de vérification incorrect ou déjà utilisé.' };
                }
            }
        }
        loginFailures.delete(keys.pair);
        const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
        await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await db.session.create({ data: { id: hash(token), csrf, userId: user.id, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) } });
        reply.setCookie(cookieName, token, cookieOptions);
        return { user: { id: user.id, name: user.name, email: user.email, totpEnabled: user.totpEnabled, role: user.role }, csrf, ...(user.role === 'admin' && !user.totpEnabled ? { enrollmentRequired: true } : {}) };
    });
    app.get('/api/auth/me', async (req) => ({ user: req.user, csrf: (await db.session.findUniqueOrThrow({ where: { id: req.sessionId } })).csrf }));
    app.post('/api/auth/logout', async (req, reply) => { await db.session.deleteMany({ where: { id: req.sessionId } }); reply.clearCookie(cookieName, { path: '/', secure: prod }); return { ok: true }; });
    // Chaque utilisateur gère son propre compte (nom, email de connexion, mot de passe).
    app.post('/api/auth/profile', async (req) => {
        const { name } = profileSchema.parse(req.body);
        const u = await db.user.update({ where: { id: req.user.id }, data: { name } });
        return { ok: true, name: u.name };
    });
    // Changement d'email : mot de passe + code 2FA si activée, quota par utilisateur, journalisation,
    // révocation des autres sessions. (La preuve de possession de la nouvelle adresse exige un service
    // d'envoi d'emails, absent de l'application : voir docs/CORRECTIONS-PREPRODUCTION.md.)
    app.post('/api/auth/email', { config: perUserLimit }, async (req) => {
        const b = emailChangeSchema.extend({ token: totpToken.optional() }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        await verifyPassword(user, b.password);
        if (user.totpEnabled && (!b.token || !await consumeTotp(user, b.token)))
            throw new HttpError(400, 'Code de vérification incorrect ou déjà utilisé.');
        if (b.email === user.email)
            return { ok: true, email: user.email };
        if (await db.user.findUnique({ where: { email: b.email } }))
            throw new HttpError(409, 'Cet email est déjà utilisé par un autre compte.');
        const u = await db.$transaction(async (tx) => {
            const updated = await tx.user.update({ where: { id: user.id }, data: { email: b.email } });
            await tx.session.deleteMany({ where: { userId: user.id, id: { not: req.sessionId } } });
            await tx.activityLog.create({ data: { userId: user.id, action: 'Email de connexion modifié', entity: 'users', entityId: user.id } });
            return updated;
        });
        return { ok: true, email: u.email };
    });
    // Second facteur (TOTP) : l'inscription ne l'active qu'après vérification d'un premier code.
    // Ré-authentification (mot de passe) exigée : une session volée ne peut pas réinitialiser le secret.
    app.post('/api/auth/2fa/setup', { config: perUserLimit }, async (req) => {
        const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body ?? {});
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (user.totpEnabled)
            throw new HttpError(409, 'La double authentification est déjà active.');
        await verifyPassword(user, password);
        const secret = generateSecret();
        await db.user.update({ where: { id: user.id }, data: { totpSecret: sealSecret(secret), totpLastCounter: null } });
        return { secret, otpauth: otpauthURL(secret, user.email) };
    });
    app.post('/api/auth/2fa/enable', { config: perUserLimit }, async (req) => {
        const { token } = z.object({ token: totpToken }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (user.totpEnabled)
            throw new HttpError(409, 'La double authentification est déjà active.');
        if (!user.totpSecret || !await consumeTotp(user, token))
            throw new HttpError(400, 'Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.');
        const recoveryCodes = await db.$transaction(async (tx) => {
            await tx.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
            await tx.session.deleteMany({ where: { userId: user.id, id: { not: req.sessionId } } });
            await tx.activityLog.create({ data: { userId: user.id, action: 'Double authentification activée', entity: 'users', entityId: user.id } });
            return replaceRecoveryCodes(tx, user.id);
        });
        return { ok: true, recoveryCodes };
    });
    // Régénère les codes de secours (les anciens sont invalidés). Mot de passe + code TOTP exigés.
    app.post('/api/auth/2fa/recovery-codes', { config: perUserLimit }, async (req) => {
        const b = z.object({ password: z.string().max(256), token: totpToken }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        await verifyPassword(user, b.password);
        if (!user.totpEnabled || !await consumeTotp(user, b.token))
            throw new HttpError(400, 'Code de vérification incorrect ou déjà utilisé.');
        const recoveryCodes = await db.$transaction(tx => replaceRecoveryCodes(tx, user.id));
        return { ok: true, recoveryCodes };
    });
    app.post('/api/auth/2fa/disable', { config: perUserLimit }, async (req) => {
        const b = z.object({ password: z.string().max(256), token: totpToken }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        await verifyPassword(user, b.password);
        if (!user.totpEnabled || !await consumeTotp(user, b.token))
            throw new HttpError(400, 'Code de vérification incorrect.');
        await db.$transaction([
            db.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: '', totpLastCounter: null } }),
            db.totpRecoveryCode.deleteMany({ where: { userId: user.id } }),
            db.session.deleteMany({ where: { userId: user.id, id: { not: req.sessionId } } }),
            db.activityLog.create({ data: { userId: user.id, action: 'Double authentification désactivée', entity: 'users', entityId: user.id } }),
        ]);
        return { ok: true };
    });
    app.post('/api/auth/password', {config:{rateLimit:{max:5,timeWindow:'15 minutes'}}}, async (req, reply) => {
        const b = z.object({ current: z.string().max(256), password: z.string().min(14).max(128) }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (!await argon2.verify(user.passwordHash, b.current))
            throw new HttpError(400, 'Mot de passe actuel incorrect.');
        if (await isPwned(b.password))
            throw new HttpError(400, 'Ce mot de passe figure dans une fuite de données connue. Choisissez-en un autre.');
        await db.$transaction([db.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(b.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }) } }), db.session.deleteMany({ where: { userId: user.id } })]);
        reply.clearCookie(cookieName, { path: '/', secure: prod });
        return { ok: true };
    });
}
