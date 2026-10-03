import { createHash } from 'node:crypto';
const BASE = process.env.HIBP_URL || 'https://api.pwnedpasswords.com/range/';
// Contrôle « have i been pwned » par k-anonymity : seul le préfixe (5 caractères)
// du SHA-1 est transmis, jamais le mot de passe. Fail-open et surtout NON BLOQUANT :
// un Promise.race garantit une réponse en ≤1,6 s même si le réseau reste coincé,
// pour ne jamais figer une création de compte ou un changement de mot de passe.
export async function isPwned(password) {
    const lookup = (async () => {
        try {
            const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
            const res = await fetch(BASE + sha1.slice(0, 5), { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(1500) });
            if (!res.ok) return false;
            const suffix = sha1.slice(5);
            return (await res.text()).split('\n').some(line => line.split(':')[0].trim() === suffix);
        } catch { return false; }
    })();
    const cap = new Promise(resolve => setTimeout(() => resolve(false), 1600));
    return Promise.race([lookup, cap]);
}
