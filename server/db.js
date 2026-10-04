import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
export const db = new PrismaClient();
export async function transaction(work) {
    for (let attempt = 0;; attempt++) {
        try {
            return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
        }
        catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034' && attempt < 3)
                continue;
            throw e;
        }
    }
}
export async function nextReference(tx, prefix, year) {
    const n = await tx.counter.upsert({ where: { key: `${prefix}-${year}` }, create: { key: `${prefix}-${year}`, value: 1 }, update: { value: { increment: 1 } } });
    return `${prefix}-${year}-${String(n.value).padStart(3, '0')}`;
}
export async function audit(tx, userId, action, entity, entityId, links = {}) {
    return tx.activityLog.create({ data: { userId, action, entity, entityId, ...links } });
}
export function today() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date()); }
export function addDays(date, days) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export class HttpError extends Error {
    statusCode;
    publicCode;
    constructor(statusCode, message, publicCode) {
        super(message);
        this.statusCode = statusCode;
        // Code stable exposé au front (ex. TOTP_ENROLLMENT_REQUIRED) ; jamais de détail interne.
        if (publicCode) this.publicCode = publicCode;
    }
}
export function found(item) { if (!item)
    throw new HttpError(404, 'Élément introuvable.'); return item; }
