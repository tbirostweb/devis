import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, transaction, audit, found, HttpError, today } from '../db.js';
import { company } from './records.js';
import { quoteStatus } from './commercial.js';
import { abbyPaymentSchema } from '../../shared/contracts.js';
import { totals } from '../../shared/money.js';
import { redact } from '../redact.js';
import { getAbbyService, buildAbbyLines, vatMentionFor, readInvoiceSync, assertFinalizable, abbyEnabled, AbbyError } from '../services/abby/index.js';

const params = z.object({ id: z.string().min(1) });
const snapshot = (c) => ({ name: c.name, contact: c.contact, email: c.email, phone: c.phone, address: c.address, siret: c.siret });
const PAYMENT_METHODS = { transfer: 'transfer', card: 'credit_card', cash: 'cash', other: 'other' };

// Traduit une erreur Abby en réponse HTTP propre, sans jamais exposer de secret.
function toHttp(e) {
    if (e instanceof AbbyError) {
        const status = e.status === 0 ? 502 : e.status === 429 ? 503 : e.status >= 500 ? 502 : e.status;
        return new HttpError(status || 502, e.message);
    }
    return e;
}
function requireEnabled() {
    if (!abbyEnabled())
        throw new HttpError(503, 'Intégration Abby désactivée. Renseignez ABBY_API_KEY et ABBY_ENABLED.');
}

// Enregistre une erreur de synchro dans l'historique (message masqué : ni secret ni donnée personnelle).
async function logError(userId, action, invoiceId, clientId, message) {
    try { await audit(db, userId, `${action} · échec : ${redact(String(message), 180)}`, 'invoices', invoiceId, { invoiceId, clientId }); }
    catch { /* journalisation best-effort */ }
}

// --- Verrou applicatif par facture (claim atomique) ---
// Un UPDATE conditionnel ne réussit que pour une seule requête : les autres attendent ou reçoivent 409.
// Le verrou expire (LOCK_MS) pour qu'un crash ne bloque pas définitivement la facture.
const LOCK_MS = 2 * 60 * 1000;
const isComplete = (inv) => !!inv.abbyInvoiceId && (inv.abbySyncState ?? 'complete') === 'complete'; // null = ligne héritée créée avant le suivi d'état
export async function claimAbbyLock(id) {
    const now = new Date();
    const r = await db.invoice.updateMany({ where: { id, OR: [{ abbySyncLockedUntil: null }, { abbySyncLockedUntil: { lt: now } }] }, data: { abbySyncLockedUntil: new Date(now.getTime() + LOCK_MS) } });
    return r.count === 1;
}
async function releaseAbbyLock(id) {
    try { await db.invoice.updateMany({ where: { id }, data: { abbySyncLockedUntil: null } }); } catch { /* expirera seul */ }
}
async function withAbbyLock(id, work) {
    if (!await claimAbbyLock(id))
        throw new HttpError(409, 'Une opération Abby est déjà en cours pour cette facture. Réessayez dans quelques instants.', 'ABBY_SYNC_IN_PROGRESS');
    try { return await work(); }
    finally { await releaseAbbyLock(id); }
}
const fullInvoice = (id) => db.invoice.findUnique({ where: { id }, include: { client: true, items: true } }).then(found);

export async function abby(app, deps = {}) {
    const service = () => getAbbyService(deps.service);
    const waitMs = deps.lockWaitMs ?? 15000;

    // Crée (ou retrouve) la facture Abby pour un devis ACCEPTÉ. Idempotent : jamais deux factures pour un même devis.
    // Machine à états durable : creating → draft_created → lines_set → complete. Une reprise après échec repart
    // de l'étape incomplète, sans recréer de brouillon. Une création interrompue AVANT l'enregistrement de l'id
    // Abby (état « creating ») exige une confirmation explicite après vérification manuelle dans Abby.
    app.post('/api/quotes/:id/abby-invoice', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const { confirmNoDuplicate } = z.object({ confirmNoDuplicate: z.boolean().optional() }).parse(req.body ?? {});
        // 1) Verrou d'idempotence côté base : une seule Invoice par abbyQuoteKey (=quoteId).
        let local, quote;
        try {
            ({ local, quote } = await transaction(async (tx) => {
                const q = found(await tx.quote.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' } }, client: true, project: true } }));
                if (quoteStatus(q) !== 'accepted')
                    throw new HttpError(409, 'Le devis doit être accepté avant de créer la facture Abby.');
                if (q.client.status === 'archived')
                    throw new HttpError(400, 'Réactivez ce client avant de facturer.');
                const existing = await tx.invoice.findUnique({ where: { abbyQuoteKey: id } });
                if (existing) return { local: existing, quote: q };
                const settings = await company(tx);
                const selected = q.items.filter(i => !i.optional || i.selected);
                const calc = totals(selected.map(i => ({ ...i, frequency: 'once' })), q.discountBps);
                const inv = await tx.invoice.create({ data: {
                    reference: `ABY-${randomUUID().slice(0, 8).toUpperCase()}`,
                    clientId: q.clientId, quoteId: q.id, title: q.title, kind: 'final', status: 'draft',
                    issuedDate: today(), dueDate: today(), discountBps: q.discountBps, totalCents: calc.total,
                    conditions: settings.conditions, legalNotice: settings.vatEnabled ? settings.legalNotice : settings.vatExemptionText,
                    proClient: q.proClient, issuerSnapshot: settings, clientSnapshot: snapshot(q.client),
                    abbyQuoteKey: id,
                    items: { create: selected.map((i, position) => ({ name: i.name, description: i.description, category: i.category, section: i.section, quantityMilli: i.quantityMilli, unitCents: i.unitCents, discountBps: i.discountBps, vatBps: i.vatBps, frequency: 'once', optional: false, selected: true, position })) },
                } });
                await audit(tx, req.user.id, `Facture Abby préparée · ${q.reference}`, 'invoices', inv.id, { clientId: inv.clientId, quoteId: q.id, invoiceId: inv.id });
                return { local: inv, quote: q };
            }));
        }
        catch (e) {
            // Création concurrente : la contrainte unique a tranché, on relit l'existant.
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                local = found(await db.invoice.findUnique({ where: { abbyQuoteKey: id } }));
                quote = found(await db.quote.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' } }, client: true } }));
            }
            else throw e;
        }
        // 2) Déjà créée et complète chez Abby → idempotent, on renvoie tel quel.
        if (isComplete(local))
            return fullInvoice(local.id);
        // 3) Claim atomique : une seule requête pilote la création. Les autres (double-clic) attendent la fin
        //    puis renvoient le résultat, sans jamais appeler Abby une seconde fois.
        if (!await claimAbbyLock(local.id)) {
            for (const until = Date.now() + waitMs; Date.now() < until;) {
                await new Promise(r => setTimeout(r, 200));
                const current = await db.invoice.findUnique({ where: { id: local.id } });
                if (current && isComplete(current) && !current.abbySyncLockedUntil) return fullInvoice(local.id);
                if (current && !current.abbySyncLockedUntil) break;
            }
            throw new HttpError(409, 'La création de la facture Abby est déjà en cours ou doit être reprise. Réessayez dans quelques instants.', 'ABBY_SYNC_IN_PROGRESS');
        }
        try {
            let inv = found(await db.invoice.findUnique({ where: { id: local.id } })); // relu sous verrou
            if (isComplete(inv)) return fullInvoice(inv.id);
            const settings = await company();
            const svc = service();
            if (!inv.abbyInvoiceId) {
                if (inv.abbySyncState === 'creating' && !confirmNoDuplicate)
                    throw new HttpError(409, 'Une création précédente a été interrompue : un brouillon a pu être créé chez Abby. Vérifiez les brouillons de ce client dans Abby (supprimez un éventuel doublon), puis relancez en confirmant.', 'ABBY_RECONCILE_REQUIRED');
                let client = found(await db.client.findUnique({ where: { id: quote.clientId } }));
                const org = await svc.ensureOrganization(client);
                if (!client.abbyClientId) {
                    // Rattachement conditionnel : si une autre facture a lié le client entre-temps, on garde ce lien.
                    const linked = await db.client.updateMany({ where: { id: client.id, abbyClientId: null }, data: { abbyClientId: org.id } });
                    if (linked.count !== 1) client = found(await db.client.findUnique({ where: { id: client.id } }));
                    else client = { ...client, abbyClientId: org.id };
                }
                // État durable AVANT l'appel réseau : une interruption ensuite est détectée au prochain essai.
                await db.invoice.update({ where: { id: inv.id }, data: { abbySyncState: 'creating' } });
                const draft = await svc.createDraftInvoice(client.abbyClientId);
                const sync = readInvoiceSync(draft ?? {});
                if (!sync.abbyInvoiceId) throw new AbbyError(0, 'Abby n’a pas renvoyé d’identifiant de facture.');
                // On mémorise l'id Abby AVANT d'éditer les lignes : pas d'orphelin en cas d'échec ultérieur.
                inv = await db.invoice.update({ where: { id: inv.id }, data: { ...sync, abbySyncState: 'draft_created', lastSyncedAt: new Date() } });
            }
            if (inv.abbySyncState === 'draft_created') {
                const lines = buildAbbyLines(quote.items.filter(i => !i.optional || i.selected), { discountBps: quote.discountBps, vatEnabled: settings.vatEnabled });
                await svc.setInvoiceLines(inv.abbyInvoiceId, lines, quote.discountBps > 0 ? { mode: 'PERCENTAGE', amount: quote.discountBps } : undefined);
                inv = await db.invoice.update({ where: { id: inv.id }, data: { abbySyncState: 'lines_set' } });
            }
            if (inv.abbySyncState === 'lines_set') {
                const mention = vatMentionFor(settings);
                if (mention)
                    await svc.setGeneralInfo(inv.abbyInvoiceId, { vatMention: mention, footerNote: settings.vatExemptionText });
                inv = await db.invoice.update({ where: { id: inv.id }, data: { abbySyncState: 'complete' } });
                await audit(db, req.user.id, `Facture Abby créée · brouillon ${inv.abbyInvoiceId}`, 'invoices', inv.id, { clientId: quote.clientId, invoiceId: inv.id, quoteId: quote.id });
            }
        }
        catch (e) {
            await logError(req.user.id, 'Création facture Abby', local.id, quote.clientId, (e instanceof AbbyError ? e.message : e instanceof HttpError ? e.message : 'erreur interne'));
            throw toHttp(e);
        }
        finally { await releaseAbbyLock(local.id); }
        return fullInvoice(local.id);
    });

    // Finalise la facture Abby : numéro officiel irréversible. Filet de sécurité test/live.
    app.post('/api/invoices/:id/abby/finalize', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const inv = found(await db.invoice.findUnique({ where: { id }, include: { client: true } }));
        if (!inv.abbyInvoiceId) throw new HttpError(409, 'Cette facture n’existe pas encore chez Abby.');
        if (inv.abbyStatus && inv.abbyStatus !== 'draft') throw new HttpError(409, 'Cette facture Abby est déjà finalisée.');
        // Jamais de numéro officiel sur un brouillon incomplet (lignes ou mentions non encore envoyées).
        if (!isComplete(inv)) throw new HttpError(409, 'La création de cette facture chez Abby est incomplète : relancez « Créer la facture Abby » avant de finaliser.', 'ABBY_SYNC_INCOMPLETE');
        return withAbbyLock(id, async () => {
            const fresh = found(await db.invoice.findUnique({ where: { id } }));
            if (fresh.abbyStatus && fresh.abbyStatus !== 'draft') throw new HttpError(409, 'Cette facture Abby est déjà finalisée.');
            try {
                assertFinalizable({ test: fresh.abbyTest }); // refuse si pas en mode test (sauf ABBY_ALLOW_LIVE_FINALIZE=true)
                const dto = await service().finalizeInvoice(fresh.abbyInvoiceId);
                const sync = readInvoiceSync(dto);
                const updated = await db.invoice.update({ where: { id }, data: { ...sync, status: 'sent', lastSyncedAt: new Date() }, include: { client: true } });
                await audit(db, req.user.id, `Facture Abby finalisée · ${sync.abbyNumber || sync.abbyInvoiceId}`, 'invoices', id, { clientId: inv.clientId, invoiceId: id });
                return updated;
            }
            catch (e) {
                await logError(req.user.id, 'Finalisation facture Abby', id, inv.clientId, (e instanceof AbbyError ? e.message : 'erreur interne'));
                throw toHttp(e);
            }
        });
    });

    // Synchronise l'état depuis Abby (lecture idempotente).
    app.post('/api/invoices/:id/abby/sync', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const inv = found(await db.invoice.findUnique({ where: { id }, include: { client: true } }));
        if (!inv.abbyInvoiceId) throw new HttpError(409, 'Cette facture n’existe pas encore chez Abby.');
        try {
            const dto = await service().getInvoice(inv.abbyInvoiceId, { customerId: inv.client.abbyClientId, test: inv.abbyTest ?? false });
            if (!dto) throw new HttpError(404, 'Facture introuvable chez Abby.');
            const sync = readInvoiceSync(dto);
            const updated = await db.invoice.update({ where: { id }, data: { ...sync, lastSyncedAt: new Date() }, include: { client: true } });
            await audit(db, req.user.id, `Facture Abby synchronisée · ${sync.abbyStatus}`, 'invoices', id, { clientId: inv.clientId, invoiceId: id });
            return updated;
        }
        catch (e) {
            await logError(req.user.id, 'Synchronisation facture Abby', id, inv.clientId, (e instanceof AbbyError ? e.message : 'erreur interne'));
            throw toHttp(e);
        }
    });

    // Télécharge le PDF Abby (proxy du GET download).
    app.get('/api/invoices/:id/abby/pdf', async (req, reply) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const inv = found(await db.invoice.findUnique({ where: { id } }));
        if (!inv.abbyInvoiceId) throw new HttpError(409, 'Cette facture n’existe pas encore chez Abby.');
        try {
            const bytes = await service().downloadInvoicePdf(inv.abbyInvoiceId);
            await db.invoice.update({ where: { id }, data: { abbyPdfFetchedAt: new Date() } });
            return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${String(inv.abbyNumber || inv.reference).replace(/[^\w.-]/g, '_').slice(0, 80)}.pdf"`).send(bytes);
        }
        catch (e) { throw toHttp(e); }
    });

    // Marque payée / impayée côté Abby.
    app.post('/api/invoices/:id/abby/payment', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const inv = found(await db.invoice.findUnique({ where: { id }, include: { client: true } }));
        if (!inv.abbyInvoiceId) throw new HttpError(409, 'Cette facture n’existe pas encore chez Abby.');
        const b = z.object({ paid: z.boolean() }).parse(req.body);
        const p = b.paid ? abbyPaymentSchema.parse(req.body) : null;
        // Rapprochement seulement sur une facture finalisée, non déjà payée, pour un montant ≤ total facturé.
        if (b.paid) {
            if (!['finalized', 'signed'].includes(inv.abbyStatus)) throw new HttpError(409, inv.abbyStatus === 'paid' ? 'Cette facture Abby est déjà marquée payée.' : 'Finalisez la facture Abby avant d’enregistrer un règlement.');
            if (p.amountCents > inv.totalCents) throw new HttpError(400, 'Le montant réglé dépasse le total de la facture.');
        }
        else if (inv.abbyStatus !== 'paid') throw new HttpError(409, 'Cette facture Abby n’est pas marquée payée.');
        // Verrou : deux clics simultanés ne produisent jamais deux rapprochements chez Abby.
        return withAbbyLock(id, async () => {
            const fresh = found(await db.invoice.findUnique({ where: { id } }));
            if (fresh.abbyStatus !== inv.abbyStatus) throw new HttpError(409, 'La facture a changé entre-temps. Rechargez la page.');
            try {
                const dto = b.paid
                    ? await service().markPaid(inv.abbyInvoiceId, [{ amount: p.amountCents, receivedAt: p.date, method: PAYMENT_METHODS[p.method] }])
                    : await service().markUnpaid(inv.abbyInvoiceId);
                const sync = dto ? readInvoiceSync(dto) : { abbyStatus: b.paid ? 'paid' : 'finalized' };
                const updated = await db.invoice.update({ where: { id }, data: { ...sync, lastSyncedAt: new Date() }, include: { client: true } });
                await audit(db, req.user.id, `Facture Abby ${b.paid ? 'marquée payée' : 'marquée impayée'}`, 'invoices', id, { clientId: inv.clientId, invoiceId: id });
                return updated;
            }
            catch (e) {
                await logError(req.user.id, 'Paiement facture Abby', id, inv.clientId, (e instanceof AbbyError ? e.message : 'erreur interne'));
                throw toHttp(e);
            }
        });
    });
}
