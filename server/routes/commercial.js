import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, transaction, audit, nextReference, found, HttpError, today, addDays } from '../db.js';
import { quoteSchema, invoiceSchema, paymentSchema, lineSchema } from '../../shared/contracts.js';
import { totals, lineTotal } from '../../shared/money.js';
import { company, querySchema } from './records.js';
const params = z.object({ id: z.string() });
const snapshot = (c) => ({ name: c.name, contact: c.contact, email: c.email, phone: c.phone, address: c.address, siret: c.siret });
export function invoiceStatus(i) {
    if (i.status === 'draft' || i.status === 'cancelled')
        return i.status;
    const paid = i.payments.reduce((a, p) => a + p.amountCents, 0);
    return paid >= i.totalCents ? 'paid' : i.dueDate < today() ? 'overdue' : paid > 0 ? 'partial' : 'sent';
}
export function quoteStatus(q) { return ['sent', 'viewed'].includes(q.status) && q.validUntil < today() ? 'expired' : q.status; }
export async function commercial(app) {
    app.get('/api/quotes', async (req) => {
        const q = querySchema.parse(req.query);
        const status = q.status === 'expired' ? { status: { in: ['expired', 'sent', 'viewed'] }, validUntil: { lt: today() } } : q.status ? { status: q.status, ...(['sent', 'viewed'].includes(q.status) ? { validUntil: { gte: today() } } : {}) } : {};
        const where = { ...status, OR: [{ title: { contains: q.q } }, { reference: { contains: q.q } }, { client: { name: { contains: q.q } } }] };
        const [rows, count] = await Promise.all([db.quote.findMany({ where, include: { client: true, project: true, items: true }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), db.quote.count({ where })]);
        return { rows: rows.map(r => ({ ...r, status: quoteStatus(r) })), count, page: q.page };
    });
    app.get('/api/quotes/:id', async (req) => { const q = found(await db.quote.findUnique({ where: params.parse(req.params), include: { client: true, items: { orderBy: { position: 'asc' } }, project: true, documents: true, activities: { orderBy: { createdAt: 'desc' }, take: 100 } } })); return { ...q, status: quoteStatus(q) }; });
    app.post('/api/quotes', async (req) => transaction(async (tx) => {
        const b = quoteSchema.parse(req.body), settings = await company(tx), client = found(await tx.client.findUnique({ where: { id: b.clientId } }));
        if (client.status === 'archived')
            throw new HttpError(400, 'Réactivez ce client avant de créer un devis.');
        const calc = totals(b.items, b.discountBps, b.depositBps);
        const { items, ...data } = b;
        const q = await tx.quote.create({ data: { ...data, totalCents: calc.total, recurringCents: calc.mrr, issuerSnapshot: settings, clientSnapshot: snapshot(client), reference: await nextReference(tx, 'DEV', b.issuedDate.slice(0, 4)), items: { create: items } } });
        await audit(tx, req.user.id, `Devis créé · ${q.reference}`, 'quotes', q.id, { clientId: q.clientId, quoteId: q.id });
        return q;
    }));
    app.put('/api/quotes/:id', async (req) => transaction(async (tx) => {
        const { id } = params.parse(req.params), old = found(await tx.quote.findUnique({ where: { id } }));
        if (old.status !== 'draft')
            throw new HttpError(409, 'Seul un brouillon peut être modifié. Dupliquez le devis pour le réviser.');
        const b = quoteSchema.parse(req.body), { items, ...data } = b, calc = totals(items, b.discountBps, b.depositBps), client = found(await tx.client.findUnique({ where: { id: b.clientId } }));
        const q = await tx.quote.update({ where: { id }, data: { ...data, totalCents: calc.total, recurringCents: calc.mrr, clientSnapshot: snapshot(client), issuerSnapshot: await company(tx), items: { deleteMany: {}, create: items } } });
        await audit(tx, req.user.id, `Brouillon enregistré · ${q.reference}`, 'quotes', id, { clientId: q.clientId, quoteId: id });
        return q;
    }));
    app.post('/api/quotes/:id/duplicate', async (req) => transaction(async (tx) => {
        const q = found(await tx.quote.findUnique({ where: params.parse(req.params), include: { items: true } })), settings = await company(tx);
        const { id, reference, status, createdAt, updatedAt, items, ...data } = q;
        const copy = await tx.quote.create({ data: { ...data, issuedDate: today(), validUntil: addDays(today(), settings.validDays), reference: await nextReference(tx, 'DEV', today().slice(0, 4)), status: 'draft', items: { create: items.map(i => lineSchema.parse(i)) } } });
        await audit(tx, req.user.id, `Devis dupliqué · ${reference}`, 'quotes', copy.id, { clientId: copy.clientId, quoteId: copy.id });
        return copy;
    }));
    app.patch('/api/quotes/:id/status', async (req) => transaction(async (tx) => {
        const { status } = z.object({ status: z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired']) }).parse(req.body);
        const q = found(await tx.quote.findUnique({ where: params.parse(req.params) }));
        const allowed = { draft: ['sent'], sent: ['viewed', 'accepted', 'declined', 'expired'], viewed: ['accepted', 'declined', 'expired'], expired: [], accepted: [], declined: [] };
        if (!allowed[quoteStatus(q)]?.includes(status))
            throw new HttpError(409, 'Ce changement de statut n’est pas possible.');
        if (status === 'sent' && q.validUntil < today())
            throw new HttpError(400, 'Mettez à jour la validité du devis avant son envoi.');
        const result = await tx.quote.update({ where: { id: q.id }, data: { status } });
        await audit(tx, req.user.id, `Devis ${status === 'accepted' ? 'accepté' : status === 'sent' ? 'marqué envoyé' : status === 'declined' ? 'refusé' : status === 'viewed' ? 'marqué vu' : 'expiré'} · ${q.reference}`, 'quotes', q.id, { clientId: q.clientId, quoteId: q.id });
        return result;
    }));
    app.post('/api/quotes/:id/convert', async (req) => transaction(async (tx) => {
        const q = found(await tx.quote.findUnique({ where: params.parse(req.params), include: { items: true, project: true } }));
        if (q.project)
            return q.project;
        if (q.status !== 'accepted')
            throw new HttpError(409, 'Le devis doit être accepté avant conversion.');
        const p = await tx.project.create({ data: { clientId: q.clientId, quoteId: q.id, title: q.title, reference: await nextReference(tx, 'PRJ', today().slice(0, 4)), orderDate: today(), startDate: today(), dueDate: addDays(today(), 30), totalCents: q.totalCents, recurringCents: q.recurringCents, depositBps: q.depositBps, discountBps: q.discountBps, notes: q.notes, items: { create: q.items.map(i => lineSchema.parse(i)) }, tasks: { create: ['Maquette', 'Développement', 'Validation client', 'Mise en production', 'Facture finale'].map((title, position) => ({ title, position })) } } });
        const linkedInvoices=await tx.invoice.findMany({where:{quoteId:q.id,projectId:null},select:{id:true}});
        if(linkedInvoices.length){const ids=linkedInvoices.map(i=>i.id);await tx.invoice.updateMany({where:{id:{in:ids}},data:{projectId:p.id}});await tx.payment.updateMany({where:{invoiceId:{in:ids}},data:{projectId:p.id}});}
        for (const item of q.items.filter(i => i.frequency !== 'once' && (!i.optional || i.selected))) {
            await tx.subscription.create({ data: { clientId: q.clientId, projectId: p.id, name: item.name, category: item.category, amountCents: lineTotal(lineSchema.parse(item), q.discountBps).net, vatBps:item.vatBps, frequency: item.frequency, startDate: today(), nextDate: today() } });
        }
        await tx.client.update({ where: { id: q.clientId }, data: { status: 'active' } });
        await audit(tx, req.user.id, `Projet créé depuis ${q.reference}`, 'projects', p.id, { clientId: p.clientId, quoteId: q.id, projectId: p.id });
        return p;
    }));
    app.get('/api/invoices', async (req) => {
        const q = querySchema.parse(req.query);
        const search='%'+q.q+'%';
        const ledger=Prisma.sql`SELECT i.id,i.issuedDate,
          CASE WHEN i.status IN ('draft','cancelled') THEN i.status
          WHEN COALESCE(p.paid,0)>=i.totalCents THEN 'paid'
          WHEN i.dueDate<${today()} THEN 'overdue'
          WHEN COALESCE(p.paid,0)>0 THEN 'partial' ELSE 'sent' END AS resolvedStatus
          FROM Invoice i JOIN Client c ON c.id=i.clientId
          LEFT JOIN (SELECT invoiceId,SUM(amountCents) paid FROM Payment WHERE invoiceId IS NOT NULL GROUP BY invoiceId) p ON p.invoiceId=i.id
          WHERE (i.title LIKE ${search} OR i.reference LIKE ${search} OR c.name LIKE ${search})
          ${q.from?Prisma.sql`AND i.issuedDate>=${q.from}`:Prisma.empty}
          ${q.to?Prisma.sql`AND i.issuedDate<=${q.to}`:Prisma.empty}`;
        const filter=Prisma.sql`FROM (${ledger}) ranked ${q.status?Prisma.sql`WHERE ranked.resolvedStatus=${q.status}`:Prisma.empty}`;
        const [ids,counts]=await Promise.all([
          db.$queryRaw(Prisma.sql`SELECT ranked.id ${filter} ORDER BY ranked.issuedDate DESC,ranked.id DESC LIMIT ${q.limit} OFFSET ${(q.page-1)*q.limit}`),
          db.$queryRaw(Prisma.sql`SELECT COUNT(*) count ${filter}`)
        ]);
        const records=await db.invoice.findMany({where:{id:{in:ids.map(i=>i.id)}},include:{client:true,payments:true,project:true}}),byId=new Map(records.map(i=>[i.id,i]));
        return {rows:ids.map(({id})=>{const i=byId.get(id);return {...i,status:invoiceStatus(i)};}),count:Number(counts[0].count),page:q.page};
    });
    app.get('/api/invoices/:id', async (req) => { const i = found(await db.invoice.findUnique({ where: params.parse(req.params), include: { client: true, project: {include:{payments:{where:{invoiceId:null}}}}, quote: true, items: { orderBy: { position: 'asc' } }, payments: { orderBy: { date: 'desc' } }, documents: true, activities: { orderBy: { createdAt: 'desc' }, take: 100 } } })); return { ...i, status: invoiceStatus(i) }; });
    const validateInvoice = async (tx, b, total, excludeId) => {
        if (b.items.some(i => i.frequency !== 'once'))
            throw new HttpError(400, 'Une facture porte sur une échéance précise : utilisez des lignes uniques.');
        if (b.projectId) {
            const p = found(await tx.project.findUnique({ where: { id: b.projectId }, include: { invoices: { where: { status: { not: 'cancelled' }, id: excludeId ? { not: excludeId } : undefined } } } }));
            if (p.clientId !== b.clientId)
                throw new HttpError(400, 'Projet et client incompatibles.');
            if (b.quoteId && b.quoteId !== p.quoteId)
                throw new HttpError(400, 'Le devis ne correspond pas au projet.');
            const invoiced = p.invoices.reduce((a, i) => a + i.totalCents, 0);
            if (total + invoiced > p.totalCents)
                throw new HttpError(400, `Le total dépasse le montant du projet. Reste à facturer : ${((p.totalCents - invoiced) / 100).toFixed(2)} €.`);
        }
        else if (b.quoteId) {
            const q = found(await tx.quote.findUnique({ where: { id: b.quoteId },include:{project:true,invoices:{where:{status:{not:'cancelled'},id:excludeId?{not:excludeId}:undefined}}} }));
            if (q.clientId !== b.clientId)
                throw new HttpError(400, 'Devis et client incompatibles.');
            if(q.project)throw new HttpError(400,'Associez la facture au projet déjà créé pour ce devis.');
            if(q.status!=='accepted')throw new HttpError(400,'Ce devis doit être accepté avant facturation.');
            if(total+q.invoices.reduce((sum,i)=>sum+i.totalCents,0)>q.totalCents)throw new HttpError(400,'Le total dépasse le solde à facturer du devis.');
        }
    };
    app.post('/api/invoices', async (req) => transaction(async (tx) => {
        const b = invoiceSchema.parse(req.body), { items, ...data } = b, calc = totals(items, b.discountBps), client = found(await tx.client.findUnique({ where: { id: b.clientId } }));
        await validateInvoice(tx, b, calc.total);
        const i = await tx.invoice.create({ data: { ...data, totalCents: calc.total, reference: `BRO-${randomUUID().slice(0, 8).toUpperCase()}`, issuerSnapshot: await company(tx), clientSnapshot: snapshot(client), items: { create: items } } });
        await audit(tx, req.user.id, `Facture préparée · ${i.title}`, 'invoices', i.id, { clientId: i.clientId, projectId: i.projectId ?? undefined, invoiceId: i.id });
        return i;
    }));
    app.put('/api/invoices/:id', async (req) => transaction(async (tx) => {
        const { id } = params.parse(req.params), old = found(await tx.invoice.findUnique({ where: { id } }));
        if (old.status !== 'draft')
            throw new HttpError(409, 'Une facture émise est figée.');
        const b = invoiceSchema.parse(req.body), { items, ...data } = b, calc = totals(items, b.discountBps);
        await validateInvoice(tx, b, calc.total, id);
        const client = found(await tx.client.findUnique({ where: { id: b.clientId } }));
        const i = await tx.invoice.update({ where: { id }, data: { ...data, projectId: b.projectId ?? null, quoteId: b.quoteId ?? null, totalCents: calc.total, issuerSnapshot: await company(tx), clientSnapshot: snapshot(client), items: { deleteMany: {}, create: items } } });
        await audit(tx, req.user.id, 'Brouillon de facture modifié', 'invoices', id, { clientId: i.clientId, invoiceId: id });
        return i;
    }));
    app.patch('/api/invoices/:id/status', async (req) => transaction(async (tx) => {
        const b = z.object({ status: z.enum(['sent', 'cancelled']) }).parse(req.body), i = found(await tx.invoice.findUnique({ where: params.parse(req.params) }));
        if (i.status !== 'draft')
            throw new HttpError(409, 'Une facture émise est immuable. Son paiement détermine son statut.');
        let reference = i.reference;
        if (b.status === 'sent') {
            const settings = await company(tx);
            if (!settings.address || !settings.siret)
                throw new HttpError(400, 'Complétez l’adresse et le SIRET dans les paramètres avant d’émettre une facture.');
            if (i.issuedDate > today())
                throw new HttpError(400, 'La date d’émission ne peut pas être dans le futur.');
            const latest = await tx.invoice.findFirst({ where: { status: { notIn: ['draft', 'cancelled'] } }, orderBy: { issuedDate: 'desc' } });
            if (latest && i.issuedDate < latest.issuedDate)
                throw new HttpError(400, 'La date doit respecter la chronologie des factures déjà émises.');
            reference = await nextReference(tx, settings.invoicePrefix, i.issuedDate.slice(0, 4));
            const client = found(await tx.client.findUnique({ where: { id: i.clientId } }));
            await tx.invoice.update({ where: { id: i.id }, data: { issuerSnapshot: settings, clientSnapshot: snapshot(client) } });
        }
        const updated = await tx.invoice.update({ where: { id: i.id }, data: { status: b.status, reference } });
        await audit(tx, req.user.id, `Facture ${b.status === 'sent' ? 'émise' : 'annulée'} · ${reference}`, 'invoices', i.id, { clientId: i.clientId, projectId: i.projectId ?? undefined, invoiceId: i.id });
        return updated;
    }));
    app.get('/api/payments', async (req) => {
        const q = querySchema.parse(req.query);
        const where = { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } };
        const [rows, count] = await Promise.all([db.payment.findMany({ where, include: { client: true, invoice: true, project: true }, orderBy: { date: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), db.payment.count({ where })]);
        return { rows, count, page: q.page };
    });
    app.post('/api/payments/:id/allocate',async(req)=>transaction(async tx=>{
      const {invoiceId}=z.object({invoiceId:z.string().min(1)}).parse(req.body);
      const payment=found(await tx.payment.findUnique({where:params.parse(req.params)}));
      if(payment.invoiceId===invoiceId)return payment;
      if(payment.invoiceId)throw new HttpError(409,'Ce paiement est déjà affecté à une autre facture.');
      const invoice=found(await tx.invoice.findUnique({where:{id:invoiceId},include:{payments:true}}));
      if(['draft','cancelled'].includes(invoice.status)||invoice.clientId!==payment.clientId||!payment.projectId||invoice.projectId!==payment.projectId)throw new HttpError(400,'Le paiement et la facture doivent appartenir au même projet et la facture doit être émise.');
      if(payment.amountCents>invoice.totalCents-invoice.payments.reduce((s,p)=>s+p.amountCents,0))throw new HttpError(400,'Ce paiement dépasse le solde de la facture.');
      const result=await tx.payment.update({where:{id:payment.id},data:{invoiceId}});
      await audit(tx,req.user.id,`Paiement affecté à ${invoice.reference}`,'invoices',invoice.id,{invoiceId,clientId:invoice.clientId,projectId:invoice.projectId});return result;
    }));
    app.post('/api/payments', async (req) => transaction(async (tx) => {
        const b = paymentSchema.parse(req.body), previous = await tx.payment.findUnique({ where: { requestKey: b.requestKey } });
        if (previous) {
            if (previous.amountCents !== b.amountCents || previous.clientId !== b.clientId || previous.invoiceId !== (b.invoiceId ?? null) || previous.projectId !== (b.projectId ?? previous.projectId))
                throw new HttpError(409, 'Cette opération correspond déjà à un autre paiement.');
            return previous;
        }
        if (b.date > today())
            throw new HttpError(400, 'Un encaissement ne peut pas être enregistré dans le futur.');
        let projectId = b.projectId;
        if (b.invoiceId) {
            const i = found(await tx.invoice.findUnique({ where: { id: b.invoiceId }, include: { payments: true } }));
            if (i.clientId !== b.clientId || ['draft', 'cancelled'].includes(i.status))
                throw new HttpError(400, 'Choisissez une facture émise pour ce client.');
            if (projectId && i.projectId !== projectId)
                throw new HttpError(400, 'Cette facture appartient à un autre projet.');
            projectId = i.projectId ?? undefined;
            if (b.amountCents > i.totalCents - i.payments.reduce((a, p) => a + p.amountCents, 0))
                throw new HttpError(400, 'Le paiement dépasse le solde de la facture.');
        }
        if (projectId) {
            const p = found(await tx.project.findUnique({ where: { id: projectId }, include: { payments: true } }));
            if (p.clientId !== b.clientId)
                throw new HttpError(400, 'Projet et client incompatibles.');
            if (b.amountCents > p.totalCents - p.payments.reduce((a, v) => a + v.amountCents, 0))
                throw new HttpError(400, 'Le paiement dépasse le solde du projet.');
        }
        const payment = await tx.payment.create({ data: { ...b, projectId } });
        await audit(tx, req.user.id, `Paiement reçu · ${(b.amountCents / 100).toFixed(2)} €`, 'payments', payment.id, { clientId: b.clientId, projectId, invoiceId: b.invoiceId });
        return payment;
    }));
}
