import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { db, HttpError } from './db.js';
import { generateSecret, verifyTotp, otpauthURL } from './totp.js';
import { isPwned } from './pwned.js';
import { profileSchema, emailChangeSchema } from '../shared/contracts.js';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const prod = process.env.NODE_ENV === 'production';
const cookieName = prod ? '__Host-bw_session' : 'bw_session';
const cookieOptions = { httpOnly: true, secure: prod, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12 };
const loginSchema = z.object({ email: z.email().transform(s => s.toLowerCase()), password: z.string().min(1).max(256), token: z.string().regex(/^\d{6}$/).optional() });
const loginWindows = new Map();
function checkOrigin(req) {
    const origin = req.headers.origin;
    const expected = process.env.APP_ORIGIN || 'http://127.0.0.1:5184';
    const allowed = [expected];
    if (!origin || !allowed.includes(origin))
        throw new HttpError(403, 'Origine de la requête refusée.');
}
export async function auth(app) {
    // Constant-cost verification for unknown accounts too.
    const dummyHash = await argon2.hash(randomBytes(32), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    app.decorateRequest('user', null);
    app.decorateRequest('sessionId', '');
    app.addHook('onRequest', async (req) => {
        const path = req.url.split('?')[0];
        // Webhook Cal.com : authentifié par signature HMAC (voir routes/calendar.js), hors session + CSRF.
        if (!path.startsWith('/api/') || path === '/api/health' || path === '/api/webhooks/cal-com')
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
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            checkOrigin(req);
            const provided = req.headers['x-csrf-token'];
            if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(session.csrf)))
                throw new HttpError(403, 'Jeton de sécurité invalide. Rechargez la page.');
        }
    });
    app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const body = loginSchema.parse(req.body);
        const now=Date.now(),key=hash(body.email);
        for(const [k,v] of loginWindows)if(v.until<now)loginWindows.delete(k);
        const attempt=loginWindows.get(key)||{count:0,until:now+15*60*1000};
        if(attempt.count>=8)throw new HttpError(429,'Trop de tentatives. Réessayez dans 15 minutes.');
        if(loginWindows.size>=10000&&!loginWindows.has(key))throw new HttpError(429,'Trop de tentatives. Réessayez plus tard.');
        attempt.count++;loginWindows.set(key,attempt);
        const user = await db.user.findUnique({ where: { email: body.email } });
        const valid = await argon2.verify(user?.passwordHash ?? dummyHash, body.password);
        if (!user || !valid)
            throw new HttpError(401, 'Email ou mot de passe incorrect.');
        if (user.totpEnabled) {
            if (!body.token)
                return { twoFactor: true };
            if (!verifyTotp(user.totpSecret, body.token))
                return { twoFactor: true, error: 'Code de vérification incorrect.' };
        }
        loginWindows.delete(key);
        const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
        await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await db.session.create({ data: { id: hash(token), csrf, userId: user.id, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) } });
        reply.setCookie(cookieName, token, cookieOptions);
        return { user: { id: user.id, name: user.name, email: user.email, totpEnabled: user.totpEnabled, role: user.role }, csrf };
    });
    app.get('/api/auth/me', async (req) => ({ user: req.user, csrf: (await db.session.findUniqueOrThrow({ where: { id: req.sessionId } })).csrf }));
    app.post('/api/auth/logout', async (req, reply) => { await db.session.deleteMany({ where: { id: req.sessionId } }); reply.clearCookie(cookieName, { path: '/', secure: prod }); return { ok: true }; });
    // Chaque utilisateur gère son propre compte (nom, email de connexion, mot de passe).
    app.post('/api/auth/profile', async (req) => {
        const { name } = profileSchema.parse(req.body);
        const u = await db.user.update({ where: { id: req.user.id }, data: { name } });
        return { ok: true, name: u.name };
    });
    app.post('/api/auth/email', async (req) => {
        const b = emailChangeSchema.parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (!await argon2.verify(user.passwordHash, b.password))
            throw new HttpError(400, 'Mot de passe incorrect.');
        if (b.email !== user.email && await db.user.findUnique({ where: { email: b.email } }))
            throw new HttpError(409, 'Cet email est déjà utilisé par un autre compte.');
        const u = await db.user.update({ where: { id: user.id }, data: { email: b.email } });
        return { ok: true, email: u.email };
    });
    // Second facteur (TOTP) : l'inscription ne l'active qu'après vérification d'un premier code.
    app.post('/api/auth/2fa/setup', async (req) => {
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (user.totpEnabled)
            throw new HttpError(409, 'La double authentification est déjà active.');
        const secret = generateSecret();
        await db.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
        return { secret, otpauth: otpauthURL(secret, user.email) };
    });
    app.post('/api/auth/2fa/enable', async (req) => {
        const { token } = z.object({ token: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres attendu.') }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (user.totpEnabled)
            throw new HttpError(409, 'La double authentification est déjà active.');
        if (!user.totpSecret || !verifyTotp(user.totpSecret, token))
            throw new HttpError(400, 'Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.');
        await db.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
        return { ok: true };
    });
    app.post('/api/auth/2fa/disable', async (req) => {
        const b = z.object({ password: z.string().max(256), token: z.string().regex(/^\d{6}$/) }).parse(req.body);
        const user = await db.user.findUniqueOrThrow({ where: { id: req.user.id } });
        if (!await argon2.verify(user.passwordHash, b.password))
            throw new HttpError(400, 'Mot de passe incorrect.');
        if (!user.totpEnabled || !verifyTotp(user.totpSecret, b.token))
            throw new HttpError(400, 'Code de vérification incorrect.');
        await db.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: '' } });
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
