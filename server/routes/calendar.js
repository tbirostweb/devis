import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, transaction, audit, found, HttpError } from '../db.js';
import { calendarEntrySchema } from '../../shared/contracts.js';

const idParams = z.object({ id: z.string().min(1) });
const clean = b => ({ title: b.title, detail: b.detail || null, date: b.date, time: b.time || null, endTime: b.endTime || null });

// Vérifie la signature HMAC-SHA256 du corps brut Cal.com (header `x-cal-signature-256`),
// en comparaison à temps constant. Rejette si le secret manque ou si la signature diffère.
function verifySignature(req) {
    const secret = process.env.CALCOM_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(401, 'Webhook non configuré.');
    const provided = req.headers['x-cal-signature-256'];
    const raw = req.rawBody; // Buffer : corps brut capturé par le parser dédié de ce scope.
    if (typeof provided !== 'string' || !raw) throw new HttpError(401, 'Signature manquante.');
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(provided), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Signature invalide.');
}

// Normalise un payload de réservation Cal.com vers une CalendarEntry.
function fromBooking(payload) {
    const start = payload.startTime ? new Date(payload.startTime) : null;
    const end = payload.endTime ? new Date(payload.endTime) : null;
    const hhmm = d => d && !isNaN(d) ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Paris' }).format(d) : null;
    const ymd = d => d && !isNaN(d) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(d) : null;
    const attendee = Array.isArray(payload.attendees) ? payload.attendees[0] : null;
    return {
        date: ymd(start), time: hhmm(start), endTime: hhmm(end),
        title: payload.title || 'Rendez-vous',
        detail: payload.description || null,
        attendeeName: attendee?.name || null, attendeeEmail: attendee?.email || null
    };
}

// Horodatage de l'événement (champ `createdAt` du corps signé Cal.com). Fenêtre de fraîcheur anti-rejeu :
// un événement signé trop ancien (ou daté du futur) est refusé. Fenêtre réglable par CALCOM_WEBHOOK_TOLERANCE_SECONDS.
export function eventTimestamp(body, now = Date.now()) {
    const at = body.createdAt ? new Date(body.createdAt) : null;
    if (!at || isNaN(at)) throw new HttpError(400, 'Horodatage de l’événement absent.');
    const tolerance = Number(process.env.CALCOM_WEBHOOK_TOLERANCE_SECONDS || 600) * 1000;
    if (now - at.getTime() > tolerance || at.getTime() - now > 5 * 60 * 1000)
        throw new HttpError(400, 'Événement hors de la fenêtre de validité (rejeu refusé).');
    return at;
}
// Applique un événement seulement s'il est plus récent que le dernier appliqué (ordre monotone, transaction
// sérialisable) : un rejeu ou un ancien BOOKING_CREATED reçu après une annulation n'a aucun effet.
async function applyInOrder(uid, eventAt, update, create = update) {
    return transaction(async (tx) => {
        const existing = await tx.calendarEntry.findUnique({ where: { externalId: uid } });
        if (existing) {
            if (existing.lastEventAt && existing.lastEventAt >= eventAt) return { ok: true, ignored: 'stale' };
            await tx.calendarEntry.update({ where: { externalId: uid }, data: update });
        }
        else if (create) await tx.calendarEntry.create({ data: create });
        return { ok: true };
    });
}

export async function calendar(app) {
    // --- Webhook public Cal.com : scope encapsulé avec un parser de corps BRUT dédié. ---
    // Fastify consomme le corps en le parsant ; on enregistre ici un parser JSON qui conserve
    // le Buffer brut dans req.rawBody (nécessaire au calcul HMAC) tout en fournissant req.body parsé.
    // L'encapsulation limite ce parser à ce seul scope : les autres routes gardent le parser par défaut.
    app.register(async function webhookScope(scope) {
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
            req.rawBody = body;
            try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}); }
            catch (e) { done(Object.assign(e, { statusCode: 400 }), undefined); }
        });
        scope.post('/api/webhooks/cal-com', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
            verifySignature(req);
            const body = z.object({ triggerEvent: z.string(), createdAt: z.string().optional(), payload: z.object({ uid: z.string().min(1) }).passthrough() }).parse(req.body);
            const { triggerEvent, payload } = body;
            const uid = payload.uid;
            const eventAt = eventTimestamp(body);
            if (triggerEvent === 'BOOKING_CREATED' || triggerEvent === 'BOOKING_RESCHEDULED') {
                const mapped = fromBooking(payload);
                if (!mapped.date) throw new HttpError(400, 'Date de réservation absente.');
                const data = { source: 'calcom', status: 'confirmed', externalId: uid, lastEventAt: eventAt, ...mapped };
                return applyInOrder(uid, eventAt, data);
            }
            if (triggerEvent === 'BOOKING_CANCELLED' || triggerEvent === 'BOOKING_REJECTED') {
                const mapped = fromBooking(payload);
                // Annulation reçue avant la création (ordre inversé) : on conserve une entrée annulée si la date
                // est connue, pour qu'un BOOKING_CREATED plus ancien ne puisse pas la « réactiver » ensuite.
                return applyInOrder(uid, eventAt, { status: 'cancelled', lastEventAt: eventAt }, mapped.date ? { source: 'calcom', externalId: uid, ...mapped, status: 'cancelled', lastEventAt: eventAt } : null);
            }
            // Autres triggers : acquittés sans effet (idempotent).
            return { ok: true };
        });
    });

    // --- CRUD admin des entrées manuelles (garde default-deny de auth.js : réservé admin). ---
    app.get('/api/calendar-entries', async () => db.calendarEntry.findMany({ where: { source: 'manual' }, orderBy: [{ date: 'asc' }, { time: 'asc' }] }));
    app.post('/api/calendar-entries', async (req) => transaction(async (tx) => {
        const b = calendarEntrySchema.parse(req.body);
        const entry = await tx.calendarEntry.create({ data: { source: 'manual', ...clean(b) } });
        await audit(tx, req.user.id, `Entrée agenda créée · ${entry.title}`, 'calendar', entry.id);
        return entry;
    }));
    app.patch('/api/calendar-entries/:id', async (req) => transaction(async (tx) => {
        const { id } = idParams.parse(req.params);
        const existing = found(await tx.calendarEntry.findUnique({ where: { id } }));
        if (existing.source !== 'manual') throw new HttpError(409, 'Les RDV Cal.com sont en lecture seule.');
        const b = calendarEntrySchema.parse(req.body);
        const entry = await tx.calendarEntry.update({ where: { id }, data: clean(b) });
        await audit(tx, req.user.id, `Entrée agenda modifiée · ${entry.title}`, 'calendar', entry.id);
        return entry;
    }));
    app.delete('/api/calendar-entries/:id', async (req) => transaction(async (tx) => {
        const { id } = idParams.parse(req.params);
        const existing = found(await tx.calendarEntry.findUnique({ where: { id } }));
        if (existing.source !== 'manual') throw new HttpError(409, 'Les RDV Cal.com sont en lecture seule.');
        await tx.calendarEntry.delete({ where: { id } });
        await audit(tx, req.user.id, `Entrée agenda supprimée · ${existing.title}`, 'calendar', id);
        return { ok: true };
    }));
}
