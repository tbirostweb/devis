import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLocksQuote, invoiceDraftPending } from '../server/routes/commercial.js';

// Facture interne (sans lien Abby) : le statut brut détermine le verrou.
test('invoiceLocksQuote: facture interne verrouillée dès qu\'elle est émise', () => {
    assert.equal(invoiceLocksQuote({ status: 'draft' }), false); // brouillon BRO- : pas de verrou
    assert.equal(invoiceLocksQuote({ status: 'cancelled' }), false); // annulée : document révoqué, pas de verrou
    assert.equal(invoiceLocksQuote({ status: 'sent' }), true); // émise, numéro FAC- attribué
});

// Facture Abby : finalisée dès qu'un numéro officiel existe ou que l'état n'est plus « draft ».
test('invoiceLocksQuote: facture Abby verrouillée une fois finalisée', () => {
    assert.equal(invoiceLocksQuote({ abbyInvoiceId: 'ab1', abbyStatus: 'draft', abbyNumber: null }), false);
    assert.equal(invoiceLocksQuote({ abbyInvoiceId: 'ab1', abbyStatus: 'finalized', abbyNumber: 'F-2026-0007' }), true);
    assert.equal(invoiceLocksQuote({ abbyInvoiceId: 'ab1', abbyStatus: 'signed', abbyNumber: null }), true);
    assert.equal(invoiceLocksQuote({ abbyInvoiceId: 'ab1', abbyStatus: 'paid', abbyNumber: 'F-2026-0008' }), true);
    // Numéro officiel attribué même si le statut local n'est pas encore synchronisé : verrou.
    assert.equal(invoiceLocksQuote({ abbyInvoiceId: 'ab1', abbyStatus: null, abbyNumber: 'F-2026-0009' }), true);
});

test('invoiceDraftPending: seuls les brouillons déclenchent l\'avertissement', () => {
    assert.equal(invoiceDraftPending({ status: 'draft' }), true); // facture interne brouillon
    assert.equal(invoiceDraftPending({ status: 'sent' }), false);
    assert.equal(invoiceDraftPending({ status: 'cancelled' }), false);
    assert.equal(invoiceDraftPending({ abbyInvoiceId: 'ab1', abbyStatus: 'draft', abbyNumber: null }), true); // brouillon Abby
    assert.equal(invoiceDraftPending({ abbyInvoiceId: 'ab1', abbyStatus: 'finalized', abbyNumber: 'F-1' }), false);
});
