import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, transaction, audit, found, HttpError, today } from '../db.js';
import { company } from './records.js';
import { quoteStatus } from './commercial.js';
import { abbyPaymentSchema } from '../../shared/contracts.js';
import { totals } from '../../shared/money.js';
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

// Enregistre une erreur de synchro dans l'historique (message seulement, pas de secret).
async function logError(userId, action, invoiceId, clientId, message) {
    try { await audit(db, userId, `${action} · échec : ${String(message).slice(0, 180)}`, 'invoices', invoiceId, { invoiceId, clientId }); }
    catch { /* journalisation best-effort */ }
}

export async function abby(app, deps = {}) {
    const service = () => getAbbyService(deps.service);

    // Crée (ou retrouve) la facture Abby pour un devis ACCEPTÉ. Idempotent : jamais deux factures pour un même devis.
    app.post('/api/quotes/:id/abby-invoice', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
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
        // 2) Déjà créée chez Abby → idempotent, on renvoie tel quel.
        if (local.abbyInvoiceId)
            return found(await db.invoice.findUnique({ where: { id: local.id }, include: { client: true, items: true } }));
        // 3) Création côté Abby (hors transaction DB : appel réseau).
        const settings = await company();
        try {
            const svc = service();
            const client = quote.client;
            const org = await svc.ensureOrganization(client);
            if (org.created || !client.abbyClientId)
                await db.client.update({ where: { id: client.id }, data: { abbyClientId: org.id } });
            const draft = await svc.createDraftInvoice(org.id);
            const sync = readInvoiceSync(draft);
            // On mémorise l'id Abby AVANT d'éditer les lignes : pas d'orphelin en cas d'échec ultérieur.
            await db.invoice.update({ where: { id: local.id }, data: { ...sync, lastSyncedAt: new Date() } });
            const lines = buildAbbyLines(quote.items.filter(i => !i.optional || i.selected), { discountBps: quote.discountBps, vatEnabled: settings.vatEnabled });
            await svc.setInvoiceLines(sync.abbyInvoiceId, lines, quote.discountBps > 0 ? { mode: 'PERCENTAGE', amount: quote.discountBps } : undefined);
            const mention = vatMentionFor(settings);
            if (mention)
                await svc.setGeneralInfo(sync.abbyInvoiceId, { vatMention: mention, footerNote: settings.vatExemptionText });
            await audit(db, req.user.id, `Facture Abby créée · brouillon ${sync.abbyInvoiceId}`, 'invoices', local.id, { clientId: client.id, invoiceId: local.id, quoteId: quote.id });
        }
        catch (e) {
            await logError(req.user.id, 'Création facture Abby', local.id, quote.clientId, (e instanceof AbbyError ? e.message : 'erreur interne'));
            throw toHttp(e);
        }
        return found(await db.invoice.findUnique({ where: { id: local.id }, include: { client: true, items: true } }));
    });

    // Finalise la facture Abby : numéro officiel irréversible. Filet de sécurité test/live.
    app.post('/api/invoices/:id/abby/finalize', async (req) => {
        requireEnabled();
        const { id } = params.parse(req.params);
        const inv = found(await db.invoice.findUnique({ where: { id }, include: { client: true } }));
        if (!inv.abbyInvoiceId) throw new HttpError(409, 'Cette facture n’existe pas encore chez Abby.');
        if (inv.abbyStatus && inv.abbyStatus !== 'draft') throw new HttpError(409, 'Cette facture Abby est déjà finalisée.');
        try {
            assertFinalizable({ test: inv.abbyTest }); // refuse si pas en mode test (sauf ABBY_ALLOW_LIVE_FINALIZE=true)
            const dto = await service().finalizeInvoice(inv.abbyInvoiceId);
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
            return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${inv.abbyNumber || inv.reference}.pdf"`).send(bytes);
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
        try {
            let dto;
            if (b.paid) {
                const p = abbyPaymentSchema.parse(req.body);
                dto = await service().markPaid(inv.abbyInvoiceId, [{ amount: p.amountCents, receivedAt: p.date, method: PAYMENT_METHODS[p.method] }]);
            }
            else dto = await service().markUnpaid(inv.abbyInvoiceId);
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
}
