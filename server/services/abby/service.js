// Fonctions métier Abby, construites au-dessus d'un client HTTP injectable.
// Les helpers de mapping sont purs et exportés pour être testés sans réseau.
// Rappel : montants EN CENTIMES côté app == `unitPrice` en centimes côté Abby.

import { AbbyError } from './http.js';

// TVA (basis points) -> code Abby. En franchise (vatEnabled=false) tout est HT.
const VAT_CODES = { 0: 'FR_00HT', 210: 'FR_210', 550: 'FR_550', 850: 'FR_850', 1000: 'FR_1000', 2000: 'FR_2000' };

export function vatCodeFor(vatBps, vatEnabled) {
    if (!vatEnabled) return 'FR_00HT';
    return VAT_CODES[vatBps] ?? 'FR_00HT';
}

// Mention de TVA portée par la facture (réglage Settings).
export function vatMentionFor(settings) {
    if (settings?.vatEnabled) return undefined; // assujetti : pas de mention d'exonération
    return settings?.vatMention || 'vat_not_applicable';
}

// Lignes du devis/facture -> lignes Abby. `quantityMilli` (×1000) -> `quantity`.
export function buildAbbyLines(items, { discountBps = 0, vatEnabled = false } = {}) {
    void discountBps; // la remise globale est transmise séparément (champ discount)
    return items
        .filter(i => !i.optional || i.selected)
        .map((i, index) => {
            const line = {
                generatedId: i.id || `line-${index}`,
                designation: i.name,
                description: i.description || '',
                quantity: i.quantityMilli / 1000,
                quantityUnit: 'unit',
                unitPrice: i.unitCents, // centimes
                vatCode: vatCodeFor(i.vatBps, vatEnabled),
                isTaxIncluded: false,
            };
            if (i.discountBps > 0)
                line.discount = { mode: 'PERCENTAGE', amount: i.discountBps }; // 1000 = 10%
            return line;
        });
}

export function createAbbyService(http) {
    return {
        http,

        // Retrouve/crée l'organisation Abby pour un client. Idempotent via l'abbyClientId stocké côté app.
        async ensureOrganization(client) {
            if (client.abbyClientId) return { id: client.abbyClientId, created: false };
            const body = { name: client.name };
            if (client.email) body.emails = [client.email];
            if (/^\d{14}$/.test(client.siret || '')) body.siret = client.siret;
            const org = await http.post('/organization', body);
            if (!org?.id) throw new AbbyError(0, 'Abby n’a pas renvoyé d’identifiant client.', { body: org });
            return { id: org.id, created: true };
        },

        createDraftInvoice(customerId) {
            return http.post(`/v2/billing/invoice/${encodeURIComponent(customerId)}`);
        },

        setInvoiceLines(billingId, lines, discount) {
            const body = { lines };
            if (discount) body.discount = discount;
            return http.patch(`/v2/billing/${encodeURIComponent(billingId)}/lines`, body);
        },

        setGeneralInfo(invoiceId, info) {
            return http.patch(`/v2/billing/invoice/${encodeURIComponent(invoiceId)}/general-informations`, info);
        },

        // ⚠️ Crée un document légal définitif avec numéro officiel. Irréversible.
        finalizeInvoice(billingId) {
            return http.patch(`/v2/billing/${encodeURIComponent(billingId)}/finalize`, undefined);
        },

        downloadInvoicePdf(billingId, { locale } = {}) {
            return http.get(`/v2/billing/${encodeURIComponent(billingId)}/download`, { query: locale ? { locale } : undefined, expect: 'pdf' });
        },

        markPaid(invoiceId, payments) {
            return http.post(`/v2/accounting-billing/invoice/${encodeURIComponent(invoiceId)}/reconciliate`, { payments });
        },

        markUnpaid(invoiceId) {
            return http.post(`/v2/accounting-billing/invoice/${encodeURIComponent(invoiceId)}/mark-as-unpaid`, undefined, { expect: 'none' });
        },

        // Pas d'endpoint GET d'un billing unique : on pagine la liste et on filtre par id.
        async getInvoice(billingId, { customerId, test = false } = {}) {
            for (let page = 1; page <= 20; page++) {
                const res = await http.get('/v2/billings', { query: { page, limit: 100, test, type: 'invoice', ...(customerId ? { customerId } : {}) } });
                const rows = res?.billings || res?.data || res?.items || (Array.isArray(res) ? res : []);
                const match = rows.find(r => r.id === billingId);
                if (match) return match;
                if (rows.length < 100) break;
            }
            return null;
        },
    };
}

// Extrait les champs de synchronisation d'un ReadInvoiceDto Abby.
// `test` (booléen) reflète l'ÉTAT DU COMPTE Abby au moment de l'émission :
// true = document de test non légal, false = document réel légal.
export function readInvoiceSync(dto) {
    return {
        abbyInvoiceId: dto.id,
        abbyNumber: dto.number || null,
        abbyStatus: dto.state || null, // draft|finalized|signed|refused|paid
        abbyTest: typeof dto.test === 'boolean' ? dto.test : null,
    };
}

// Filet de sécurité anti-facture-légale-accidentelle : on refuse de finaliser un
// document dont le flag `test` n'est pas explicitement true, SAUF si l'exploitant
// a activé l'émission réelle en production (ABBY_ALLOW_LIVE_FINALIZE=true).
// La finalisation réelle crée un numéro officiel irréversible et e-reporté.
export function assertFinalizable(dto) {
    const live = process.env.ABBY_ALLOW_LIVE_FINALIZE === 'true';
    if (dto?.test !== true && !live)
        throw new AbbyError(0, 'Finalisation bloquée : ce document Abby n’est pas en mode test. Activez ABBY_ALLOW_LIVE_FINALIZE=true pour émettre une facture légale réelle.');
}
