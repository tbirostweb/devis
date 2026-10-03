// Mock HTTP d'Abby : simule l'API en mémoire, SANS aucun appel réseau.
// Utilisé par les tests et par le serveur e2e (ABBY_MOCK=1). Les documents créés
// portent test:true (jamais de facture légale réelle). Reproduit la forme des DTO.

export function createMockFetch({ seedError } = {}) {
    const orgs = new Map();
    const invoices = new Map();
    let seq = 0;
    const store = { orgs, invoices };

    function json(status, body) {
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
            json: async () => body,
            text: async () => JSON.stringify(body),
            arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
        };
    }
    function pdf(bytes) {
        return {
            ok: true, status: 200,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            json: async () => ({}), text: async () => '',
        };
    }
    function recompute(inv) {
        let net = 0;
        for (const l of inv.lines) {
            const gross = Math.round(l.unitPrice * l.quantity);
            const disc = l.discount?.mode === 'PERCENTAGE' ? Math.round(gross * l.discount.amount / 10000) : 0;
            net += gross - disc;
        }
        inv.total = { amountWithoutTaxAfterDiscount: net, amountWithTaxAfterDiscount: net, vatDetails: [] };
    }

    const mockFetch = async (urlStr, opts = {}) => {
        const url = new URL(urlStr);
        const path = url.pathname;
        const method = (opts.method || 'GET').toUpperCase();
        const body = opts.body ? JSON.parse(opts.body) : undefined;

        // Injection d'erreurs pour les tests (réseau/429/5xx).
        if (seedError) { const e = seedError(path, method, store); if (e) return e; }

        // Auth obligatoire.
        if (!opts.headers?.Authorization?.startsWith('Bearer '))
            return json(401, { message: 'Missing bearer token' });

        if (method === 'POST' && path === '/organization') {
            const id = `org_${++seq}`;
            const org = { id, name: body?.name, emails: body?.emails || [], siret: body?.siret, test: true, createdAt: Date.now() };
            orgs.set(id, org);
            return json(201, org);
        }
        const mInvoice = path.match(/^\/v2\/billing\/invoice\/([^/]+)$/);
        if (method === 'POST' && mInvoice) {
            const customerId = decodeURIComponent(mInvoice[1]);
            const id = `inv_${++seq}`;
            const inv = { id, number: null, type: 'invoice', state: 'draft', customer: { id: customerId }, lines: [], total: { amountWithoutTaxAfterDiscount: 0, amountWithTaxAfterDiscount: 0, vatDetails: [] }, billingLegals: {}, test: true, isEditable: true, finalizable: true, createdAt: Date.now() };
            invoices.set(id, inv);
            return json(201, inv);
        }
        const mLines = path.match(/^\/v2\/billing\/([^/]+)\/lines$/);
        if (method === 'PATCH' && mLines) {
            const inv = invoices.get(mLines[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            if (inv.state !== 'draft') return json(409, { message: 'Document is not editable' });
            inv.lines = (body?.lines || []).map((l, i) => ({ id: `l_${i}`, ...l }));
            inv.discount = body?.discount;
            recompute(inv);
            return json(200, inv);
        }
        const mGen = path.match(/^\/v2\/billing\/invoice\/([^/]+)\/general-informations$/);
        if (method === 'PATCH' && mGen) {
            const inv = invoices.get(mGen[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            inv.billingLegals = { ...inv.billingLegals, ...body };
            return json(200, inv);
        }
        const mFin = path.match(/^\/v2\/billing\/([^/]+)\/finalize$/);
        if (method === 'PATCH' && mFin) {
            const inv = invoices.get(mFin[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            if (inv.state !== 'draft') return json(409, { message: 'Already finalized' });
            inv.state = 'finalized';
            inv.number = `F-${new Date().getFullYear()}-${String(++seq).padStart(4, '0')}`;
            inv.finalizedAt = Date.now();
            inv.isEditable = false; inv.finalizable = false;
            return json(200, inv);
        }
        const mDl = path.match(/^\/v2\/billing\/([^/]+)\/download$/);
        if (method === 'GET' && mDl) {
            const inv = invoices.get(mDl[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            return pdf(new TextEncoder().encode(`%PDF-1.4\n% Mock Factur-X ${inv.number || inv.id}\n%%EOF`));
        }
        const mRec = path.match(/^\/v2\/accounting-billing\/invoice\/([^/]+)\/reconciliate$/);
        if (method === 'POST' && mRec) {
            const inv = invoices.get(mRec[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            inv.state = 'paid'; inv.paidAt = Date.now();
            return json(200, inv);
        }
        const mUnpaid = path.match(/^\/v2\/accounting-billing\/invoice\/([^/]+)\/mark-as-unpaid$/);
        if (method === 'POST' && mUnpaid) {
            const inv = invoices.get(mUnpaid[1]);
            if (!inv) return json(404, { message: 'Billing not found' });
            inv.state = 'finalized'; inv.paidAt = null;
            return json(200, inv);
        }
        if (method === 'GET' && path === '/v2/billings') {
            const customerId = url.searchParams.get('customerId');
            const list = [...invoices.values()].filter(i => !customerId || i.customer?.id === customerId);
            return json(200, { billings: list, count: list.length });
        }
        return json(404, { message: `Mock: unhandled ${method} ${path}` });
    };
    mockFetch.store = store;
    return mockFetch;
}
