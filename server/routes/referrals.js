import { z } from 'zod';
import { db, transaction, audit, found, HttpError, today } from '../db.js';
import { referrerSchema, commissionSchema, settlementSchema } from '../../shared/contracts.js';
import { commissionAmount, DAS2_THRESHOLD_CENTS } from '../../shared/money.js';
const idParams = z.object({ id: z.string().min(1) });
const listQuery = z.object({ q: z.string().max(200).default(''), status: z.string().max(40).default(''), referrerId: z.string().max(60).default(''), year: z.string().regex(/^\d{4}$/).default(today().slice(0, 4)), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
const sum = (rows, keep) => rows.filter(keep).reduce((n, c) => n + c.amountCents, 0);
// Une commission n'est exigible qu'une fois le client encaissé : le statut reste
// le fait de l'utilisateur, jamais une dérivation automatique d'un paiement.
export async function referrals(app) {
    app.get('/api/referrers', async (req) => {
        const q = listQuery.parse(req.query);
        const where = { name: { contains: q.q }, ...(q.status ? { status: q.status } : {}) };
        const rows = await db.referrer.findMany({ where, include: { _count: { select: { clients: true } }, documents: { orderBy: { createdAt: 'desc' } }, commissions: { select: { amountCents: true, status: true, paidDate: true } } }, orderBy: { name: 'asc' }, take: 200 });
        return { year: q.year, thresholdCents: DAS2_THRESHOLD_CENTS, rows: rows.map(({ commissions, documents, ...r }) => {
                const paidYearCents = sum(commissions, c => c.status === 'settled' && c.paidDate?.startsWith(q.year));
                return { ...r, documents: documents.map(({ storageKey, ...d }) => d), commissionCount: commissions.length, awaitingCents: sum(commissions, c => c.status === 'awaiting'), dueCents: sum(commissions, c => c.status === 'due'), paidYearCents, paidTotalCents: sum(commissions, c => c.status === 'settled'), das2: paidYearCents > DAS2_THRESHOLD_CENTS };
            }) };
    });
    app.post('/api/referrers', async (req) => transaction(async (tx) => { const r = await tx.referrer.create({ data: referrerSchema.parse(req.body) }); await audit(tx, req.user.id, `Apporteur ajouté · ${r.name}`, 'referrers', r.id); return r; }));
    app.patch('/api/referrers/:id', async (req) => transaction(async (tx) => { const r = await tx.referrer.update({ where: idParams.parse(req.params), data: referrerSchema.parse(req.body) }); await audit(tx, req.user.id, `Apporteur ${r.status === 'archived' ? 'archivé' : 'modifié'} · ${r.name}`, 'referrers', r.id); return r; }));
    app.get('/api/commissions', async (req) => {
        const q = listQuery.parse(req.query);
        const where = { ...(q.status ? { status: q.status } : {}), ...(q.referrerId ? { referrerId: q.referrerId } : {}), ...(q.q ? { OR: [{ label: { contains: q.q } }, { reference: { contains: q.q } }, { client: { name: { contains: q.q } } }, { referrer: { name: { contains: q.q } } }] } : {}) };
        const [rows, count, groups] = await Promise.all([
            db.commission.findMany({ where, include: { referrer: { select: { id: true, name: true, status: true, siret: true } }, client: { select: { id: true, name: true } }, project: { select: { id: true, title: true, reference: true } }, invoice: { select: { id: true, reference: true } } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
            db.commission.count({ where }),
            db.commission.groupBy({ by: ['status'], where, _sum: { amountCents: true } })
        ]);
        const bucket = (status) => groups.find(g => g.status === status)?._sum.amountCents ?? 0;
        return { rows, count, page: q.page, stats: { awaitingCents: bucket('awaiting'), dueCents: bucket('due'), settledCents: bucket('settled') } };
    });
    const links = async (tx, b) => {
        const referrer = found(await tx.referrer.findUnique({ where: { id: b.referrerId } }));
        if (referrer.status === 'archived')
            throw new HttpError(400, 'Cet apporteur est archivé. Réactivez-le avant d’enregistrer une commission.');
        const client = found(await tx.client.findUnique({ where: { id: b.clientId } }));
        if (b.projectId) {
            const p = found(await tx.project.findUnique({ where: { id: b.projectId } }));
            if (p.clientId !== b.clientId)
                throw new HttpError(400, 'Ce projet appartient à un autre client.');
        }
        if (b.invoiceId) {
            const i = found(await tx.invoice.findUnique({ where: { id: b.invoiceId } }));
            if (i.clientId !== b.clientId)
                throw new HttpError(400, 'Cette facture appartient à un autre client.');
        }
        if (b.date > today())
            throw new HttpError(400, 'Une commission se calcule sur un encaissement déjà reçu : la date ne peut pas être dans le futur.');
        return { referrer, client };
    };
    app.post('/api/commissions', async (req) => transaction(async (tx) => {
        const b = commissionSchema.parse(req.body), { referrer, client } = await links(tx, b);
        const c = await tx.commission.create({ data: { ...b, label: b.label || client.name, amountCents: commissionAmount(b.baseCents, b.rateBps) } });
        await audit(tx, req.user.id, `Commission enregistrée · ${referrer.name} · ${(c.amountCents / 100).toFixed(2)} €`, 'commissions', c.id, { clientId: c.clientId, projectId: c.projectId ?? undefined, invoiceId: c.invoiceId ?? undefined });
        return c;
    }));
    app.patch('/api/commissions/:id', async (req) => transaction(async (tx) => {
        const { id } = idParams.parse(req.params), old = found(await tx.commission.findUnique({ where: { id } }));
        if (old.status === 'settled')
            throw new HttpError(409, 'Une commission versée est figée : annulez d’abord son versement.');
        const b = commissionSchema.parse(req.body), { referrer, client } = await links(tx, b);
        const c = await tx.commission.update({ where: { id }, data: { ...b, projectId: b.projectId ?? null, invoiceId: b.invoiceId ?? null, label: b.label || client.name, amountCents: commissionAmount(b.baseCents, b.rateBps) } });
        await audit(tx, req.user.id, `Commission modifiée · ${referrer.name}`, 'commissions', c.id, { clientId: c.clientId, projectId: c.projectId ?? undefined, invoiceId: c.invoiceId ?? undefined });
        return c;
    }));
    app.patch('/api/commissions/:id/status', async (req) => transaction(async (tx) => {
        const { status } = z.object({ status: z.enum(['awaiting', 'due', 'cancelled']) }).parse(req.body);
        const c = found(await tx.commission.findUnique({ where: idParams.parse(req.params), include: { referrer: true } }));
        if (c.status === status)
            return c;
        const reverting = c.status === 'settled';
        if (reverting && status !== 'due')
            throw new HttpError(409, 'Annulez d’abord le versement de cette commission.');
        const updated = await tx.commission.update({ where: { id: c.id }, data: { status, ...(reverting ? { paidDate: null, expenseId: null, reference: '' } : {}) } });
        // La dépense née du versement disparaît avec lui — le lien est rompu avant la
        // suppression — sauf si un justificatif y est déjà rattaché.
        if (reverting && c.expenseId && !await tx.document.count({ where: { expenseId: c.expenseId } }))
            await tx.expense.delete({ where: { id: c.expenseId } });
        await audit(tx, req.user.id, `Commission ${reverting ? 'non versée · versement annulé' : status === 'due' ? 'exigible' : status === 'cancelled' ? 'annulée' : 'en attente d’encaissement'} · ${c.referrer.name}`, 'commissions', c.id, { clientId: c.clientId, projectId: c.projectId ?? undefined });
        return updated;
    }));
    app.post('/api/commissions/:id/settle', async (req) => transaction(async (tx) => {
        const b = settlementSchema.parse(req.body);
        const c = found(await tx.commission.findUnique({ where: idParams.parse(req.params), include: { referrer: true, client: true } }));
        if (c.status === 'settled')
            throw new HttpError(409, 'Cette commission a déjà été versée.');
        if (c.status !== 'due')
            throw new HttpError(409, 'Marquez d’abord la commission « à verser » : elle n’est due qu’après l’encaissement du client.');
        if (b.paidDate > today())
            throw new HttpError(400, 'Un versement ne peut pas être daté dans le futur.');
        if (b.paidDate < c.date)
            throw new HttpError(400, 'Le versement ne peut pas précéder l’encaissement du client.');
        const expense = b.recordExpense ? await tx.expense.create({ data: { supplier: c.referrer.name, date: b.paidDate, dueDate: b.paidDate, netCents: c.amountCents, vatBps: 0, totalCents: c.amountCents, category: 'Commissions d’apport', paid: true, method: b.method, comment: `Commission apport affaire · client ${c.client.name}${b.reference ? ` · ${b.reference}` : ''}` } }) : null;
        const updated = await tx.commission.update({ where: { id: c.id }, data: { status: 'settled', paidDate: b.paidDate, method: b.method, reference: b.reference, expenseId: expense?.id ?? null } });
        await audit(tx, req.user.id, `Commission versée · ${c.referrer.name} · ${(c.amountCents / 100).toFixed(2)} €`, 'commissions', c.id, { clientId: c.clientId, projectId: c.projectId ?? undefined });
        return updated;
    }));
    app.delete('/api/commissions/:id', async (req) => transaction(async (tx) => {
        const c = found(await tx.commission.findUnique({ where: idParams.parse(req.params) }));
        if (c.status === 'settled')
            throw new HttpError(409, 'Une commission versée est conservée comme justificatif. Annulez son versement d’abord.');
        await tx.commission.delete({ where: { id: c.id } });
        await audit(tx, req.user.id, 'Commission supprimée', 'commissions', c.id, { clientId: c.clientId });
        return { ok: true };
    }));
}
