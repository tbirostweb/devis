import { scheduleRetention } from './retention.js';
import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from './db.js';
import { safeError } from './redact.js';
import { totpKey } from './secrets.js';
import { parseTrustProxy } from './config.js';
import { auth } from './auth.js';
import { records } from './routes/records.js';
import { commercial } from './routes/commercial.js';
import { abby } from './routes/abby.js';
import { reporting } from './routes/reporting.js';
import { calendar } from './routes/calendar.js';
import { referrals } from './routes/referrals.js';
import { team } from './routes/team.js';
import { files } from './routes/files.js';
const prod = process.env.NODE_ENV === 'production';
if (prod && (!process.env.APP_ORIGIN?.startsWith('https://') || !process.env.DATABASE_URL))
    throw new Error('APP_ORIGIN HTTPS et DATABASE_URL sont obligatoires en production.');
if (prod && process.env.ADMIN_PASSWORD && process.env.INITIALIZE_ADMIN !== 'true')
    console.warn('AVERTISSEMENT : ADMIN_PASSWORD est encore présent alors que INITIALIZE_ADMIN n’est pas actif. Retirez ce secret des variables d’environnement.');
// Clé de chiffrement des secrets 2FA : obligatoire en production (la 2FA administrateur est imposée).
if (prod && !totpKey())
    throw new Error('TOTP_ENCRYPTION_KEY (32 octets, base64 ou hex) est obligatoire en production.');
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (prod && trustProxy === true)
    console.warn('AVERTISSEMENT : TRUST_PROXY=true fait confiance à toute adresse. Indiquez plutôt l’IP/CIDR du proxy Traefik/Dokploy.');
const app = Fastify({ logger: { level: prod ? 'info' : 'warn', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token'] }, trustProxy, bodyLimit: 512 * 1024 });
await app.register(cookie);
app.addHook('onRoute', options => { if (options.url.startsWith('/api/')) options.compress = false; });
await app.register(compress, { global: true, globalDecompression: false });
await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: prod ? [] : null } }, hsts: prod });
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 6 } });
app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
        return reply.code(400).send({ message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' · ') });
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025')
            return reply.code(404).send({ message: 'Élément introuvable.' });
        if (error.code === 'P2002')
            return reply.code(409).send({ message: 'Cette référence existe déjà.' });
        if (error.code === 'P2003')
            return reply.code(409).send({ message: 'Cet élément est lié à un autre dossier.' });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500)
        req.log.error({ err: safeError(error) }, 'Erreur serveur');
    reply.code(status).send({ message: status >= 500 ? 'Une erreur est survenue. Réessayez.' : error.message, ...(status < 500 && error.publicCode ? { code: error.publicCode } : {}) });
});
app.addHook('onSend', async (req, reply, payload) => { reply.header('X-Robots-Tag', 'noindex, nofollow'); if (req.url.startsWith('/api/'))
    reply.header('Cache-Control', 'no-store'); return payload; });
app.get('/api/health', async () => { await db.$queryRaw `SELECT 1`; return { ok: true }; });
await auth(app);
await records(app);
await commercial(app);
await abby(app);
await reporting(app);
await calendar(app);
await referrals(app);
await team(app);
await files(app);
if (existsSync(resolve('dist/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist'), wildcard: false, compress: true });
    app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ message: 'Route inconnue.' });
        const path = req.url.split('?')[0];
        const known = /^\/(?:$|(?:clients|quotes|projects|invoices|expenses)(?:\/[^/]+(?:\/edit)?)?\/?$|(?:services|documents|calendar|finances|apporteurs|equipe|portail|settings|confidentialite)\/?$)/.test(path);
        return reply.code(known ? 200 : 404).sendFile('index.html');
    });
}
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, async () => { await app.close(); await db.$disconnect(); process.exit(0); });
await app.listen({ port: Number(process.env.PORT || 3001), host: prod ? '0.0.0.0' : '127.0.0.1' });
scheduleRetention(db, app.log);
app.log.info('Birostweb API démarrée');
