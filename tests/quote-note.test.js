import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSchema } from '../shared/contracts.js';
import { makePdf } from '../server/pdf.js';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const now = today();
const line = (extra = {}) => ({ name: 'Site vitrine', description: 'desc', category: 'Création de site', section: 'Projet', unitCents: 99900, quantityMilli: 1000, discountBps: 0, vatBps: 0, frequency: 'once', optional: false, selected: true, position: 0, ...extra });
const quoteBody = (extra = {}) => ({ clientId: 'c1', title: 'Refonte', issuedDate: now, validUntil: addDays(now, 30), items: [line()], ...extra });

test('quoteSchema: la note projet et le booléen notesOnPdf sont validés et par défaut privés', () => {
    const parsed = quoteSchema.parse(quoteBody({ notes: 'Projet sensible à livrer avant le salon.' }));
    assert.equal(parsed.notesOnPdf, false); // défaut : note interne
    assert.equal(parsed.notes, 'Projet sensible à livrer avant le salon.');
    assert.equal(quoteSchema.parse(quoteBody({ notes: 'x', notesOnPdf: true })).notesOnPdf, true);
    assert.equal(quoteSchema.safeParse(quoteBody({ notesOnPdf: 'oui' })).success, false); // booléen strict
});

const NOTE = 'NOTE-DE-TEST '.repeat(120); // note longue et distinctive
const record = (extra = {}) => ({
    reference: 'DEV-2026-0001', title: 'Refonte', status: 'sent', issuedDate: now, validUntil: addDays(now, 30),
    depositBps: 3000, discountBps: 0, estimatedDelay: '', conditions: '', legalNotice: '', proClient: false,
    notes: NOTE, notesOnPdf: false,
    issuerSnapshot: { name: 'Birostweb', owner: 'Théo', address: 'Paris', email: 'c@x.fr', phone: '', siret: '', iban: '' },
    clientSnapshot: { name: 'Client', contact: '', address: '', email: 'client@x.fr', siret: '' },
    items: [line()], ...extra,
});

test('makePdf (Devis) : la note projet n’est imprimée que si notesOnPdf est vrai', async () => {
    const [withNote, withoutNote, emptyNote] = await Promise.all([
        makePdf(record({ notesOnPdf: true }), 'Devis'),
        makePdf(record({ notesOnPdf: false }), 'Devis'),
        makePdf(record({ notesOnPdf: true, notes: '' }), 'Devis'),
    ]);
    assert.ok(withNote.subarray(0, 5).toString().startsWith('%PDF'));
    // Case cochée => section ajoutée => PDF sensiblement plus volumineux.
    assert.ok(withNote.length > withoutNote.length + 200, `attendu note imprimée (${withNote.length} vs ${withoutNote.length})`);
    // Case décochée ou note vide => aucune section, taille identique.
    assert.equal(emptyNote.length, withoutNote.length);
});

test('makePdf (Facture) : la note projet n’est jamais imprimée sur une facture', async () => {
    const [withFlag, withoutFlag] = await Promise.all([
        makePdf(record({ notesOnPdf: true }), 'Facture'),
        makePdf(record({ notesOnPdf: false }), 'Facture'),
    ]);
    assert.equal(withFlag.length, withoutFlag.length);
});
