// TRUST_PROXY : liste d'IP/CIDR du reverse proxy (recommandé), nombre de sauts, ou 'true' (déconseillé : fait confiance à tout X-Forwarded-For).
export function parseTrustProxy(value) {
    if (!value || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value.split(',').map(s => s.trim()).filter(Boolean);
}
