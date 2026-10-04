// Masque les données personnelles et secrets probables avant journalisation ou stockage d'un message
// d'erreur provenant d'un fournisseur (Abby) ou d'une exception (Prisma, réseau).
const RULES = [
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [masqué]'],
    [/\bsuk-[A-Za-z0-9._-]+/g, '[clé masquée]'],
    [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[email masqué]'],
    [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, '[IBAN masqué]'],
    [/(?:\+33|0033|\b0)[1-9](?:[ .-]?\d{2}){4}\b/g, '[téléphone masqué]'],
    [/\b\d{14}\b/g, '[SIRET masqué]'],
    [/("?(?:password|passwd|secret|token|apiKey|api_key|authorization|iban|totpSecret)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1[masqué]'],
];
export function redact(value, max = 500) {
    if (value == null) return '';
    let text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
    for (const [re, rep] of RULES) text = text.replace(re, rep);
    return text.length > max ? text.slice(0, max) + '…' : text;
}
// Objet d'erreur sûr pour le logger : type, code, message masqué, pile sans la ligne de message.
export function safeError(error) {
    const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 8).join('\n') : undefined;
    return { type: error?.name || 'Error', code: typeof error?.code === 'string' ? error.code : undefined, status: error?.status, message: redact(error?.message, 300), stack };
}
