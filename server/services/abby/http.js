// Couche HTTP dédiée à Abby. Toute communication avec Abby passe par ici :
// authentification Bearer, base URL depuis l'environnement, timeouts, gestion
// d'erreurs et retries UNIQUEMENT sur les lectures idempotentes.
// Le `fetch` est injectable pour permettre le mock complet en test (aucun réseau).

export class AbbyError extends Error {
    constructor(status, message, { body, cause } = {}) {
        super(message);
        this.name = 'AbbyError';
        this.status = status; // 0 = réseau/timeout ; sinon code HTTP
        this.body = body;
        if (cause) this.cause = cause;
    }
}

const DEFAULT_BASE = 'https://api.app-abby.com';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

import { redact } from '../../redact.js';

// Tronque ET masque un corps d'erreur fournisseur (emails, IBAN, téléphones, jetons…) avant tout log/stockage.
function safeBody(value) {
    if (value == null) return undefined;
    return redact(value, 500);
}

export function createAbbyHttp({
    apiKey = process.env.ABBY_API_KEY,
    baseUrl = process.env.ABBY_API_BASE || DEFAULT_BASE,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 300,
} = {}) {
    if (!apiKey)
        throw new AbbyError(0, 'Clé API Abby absente. Renseignez ABBY_API_KEY.');
    const root = baseUrl.replace(/\/$/, '');

    async function request(method, path, { query, body, expect = 'json' } = {}) {
        const idempotent = method === 'GET';
        const url = new URL(root + path);
        if (query)
            for (const [k, v] of Object.entries(query))
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        const headers = { Authorization: `Bearer ${apiKey}`, Accept: expect === 'pdf' ? 'application/pdf' : 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const maxAttempts = idempotent ? retries + 1 : 1;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let res;
            try {
                res = await fetchImpl(url.toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
            }
            catch (e) {
                clearTimeout(timer);
                lastError = new AbbyError(0, controller.signal.aborted ? `Abby : délai dépassé (${timeoutMs} ms).` : `Abby injoignable : ${e.message}`, { cause: e });
                if (idempotent && attempt < maxAttempts) { await delay(retryDelayMs * attempt); continue; }
                throw lastError;
            }
            clearTimeout(timer);
            if (!res.ok) {
                const payload = await parse(res);
                if (RETRYABLE.has(res.status) && idempotent && attempt < maxAttempts) {
                    lastError = new AbbyError(res.status, httpMessage(res.status), { body: safeBody(payload) });
                    await delay(retryDelayMs * attempt);
                    continue;
                }
                throw new AbbyError(res.status, messageFrom(payload) || httpMessage(res.status), { body: safeBody(payload) });
            }
            if (expect === 'pdf') return Buffer.from(await res.arrayBuffer());
            if (expect === 'none') return undefined;
            return parse(res);
        }
        throw lastError ?? new AbbyError(0, 'Abby : échec après plusieurs tentatives.');
    }

    return {
        baseUrl: root,
        request,
        get: (path, opts) => request('GET', path, opts),
        post: (path, body, opts) => request('POST', path, { ...opts, body }),
        patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
        put: (path, body, opts) => request('PUT', path, { ...opts, body }),
    };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function parse(res) {
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) return res.json().catch(() => null);
    return res.text().catch(() => null);
}
function messageFrom(payload) {
    if (!payload) return null;
    const raw = typeof payload === 'string' ? payload : payload.message || payload.error || (Array.isArray(payload.errors) ? payload.errors.join(' · ') : null);
    // Le message fournisseur est affiché à l'administrateur et journalisé : on le masque et le borne.
    return raw ? redact(String(raw), 300) : null;
}
function httpMessage(status) {
    return {
        400: 'Abby : requête invalide (400).',
        401: 'Abby : authentification refusée (401). Vérifiez la clé API.',
        403: 'Abby : accès interdit (403).',
        404: 'Abby : ressource introuvable (404).',
        409: 'Abby : conflit (409).',
        429: 'Abby : trop de requêtes (429). Réessayez plus tard.',
    }[status] || `Abby : erreur serveur (${status}).`;
}
