import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, transaction, audit, found, HttpError, today } from '../db.js';
import { clientSchema, serviceSchema, expenseSchema, settingsSchema, subscriptionSchema, projectPatch, defaultLatePaymentNotice } from '../../shared/contracts.js';
import { ratio } from '../../shared/money.js';
import {randomUUID} from 'node:crypto';
import {addDays} from '../db.js';
import {clientLedger} from '../../shared/ledger.js';
const idParams = z.object({ id: z.string().min(1) });
export const querySchema = z.object({ q: z.string().max(200).default(''), status: z.string().max(40).default(''), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), sort: z.enum(['name', 'date', 'amount']).default('date'), from: z.string().optional(), to: z.string().optional() });
export const defaultSettings = { name: 'Birostweb', owner: 'Théo Birost', address: '', email: 'contact@theo-birost.fr', phone: '', siret: '', iban: '', legalNotice: 'TVA non applicable, art. 293 B du CGI.', conditions: 'Acompte à la commande. Solde à la livraison. Paiement par virement.', validDays: 30, depositBps: 3000, invoicePrefix: 'FAC', logoDocumentId: '', latePaymentNotice: defaultLatePaymentNotice, vatEnabled: false, vatExemptionText: 'TVA non applicable, art. 293 B du CGI', vatMention: 'vat_not_applicable' };
export async function company(tx = db) { const row = await tx.settings.findUnique({ where: { id: 'company' } }); return settingsSchema.parse(row?.data ?? defaultSettings); }
export async function records(app) {
    app.get('/api/lookups', async () => ({ clients: await db.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' }, take: 1000 }), services: await db.service.findMany({ where: { active: true }, include: { category: true }, orderBy: { name: 'asc' }, take: 1000 }), categories: await db.serviceCategory.findMany({ orderBy: { name: 'asc' } }), referrers: await db.referrer.findMany({ where: { status: { not: 'archived' } }, select: { id: true, name: true, status: true, siret: true }, orderBy: { name: 'asc' }, take: 500 }), projects: await db.project.findMany({ select: { id: true, title: true, clientId: true, totalCents: true }, take: 1000 }), settings: await company() }));
    app.get('/api/clients', async (req) => {
        const q = querySchema.parse(req.query);
        const where = { ...(q.status ? { status: q.status } : {}), OR: ['name', 'email', 'contact'].map(key => ({ [key]: { contains: q.q } })) };
        const [rows, count] = await Promise.all([db.client.findMany({ where, orderBy: q.sort === 'name' ? { name: 'asc' } : { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { _count: { select: { projects: true } }, payments: true, projects: { select: { id:true,totalCents: true, orderDate: true, status: true } },invoices:{include:{payments:true}} } }), db.client.count({ where })]);
        return { rows: rows.map(c => ({ ...c,...clientLedger(c),lastProject: c.projects.map(p => p.orderDate).sort().at(-1) })), count, page: q.page };
    });
    app.post('/api/clients', async (req) => transaction(async (tx) => { const data = clientSchema.parse(req.body); if (data.referrerId) found(await tx.referrer.findUnique({ where: { id: data.referrerId } })); const c = await tx.client.create({ data }); await audit(tx, req.user.id, `Client créé · ${c.name}`, 'clients', c.id, { clientId: c.id }); return c; }));
    app.patch('/api/clients/:id', async (req) => transaction(async (tx) => { const { id } = idParams.parse(req.params); const data = clientSchema.parse(req.body); if (data.referrerId) found(await tx.referrer.findUnique({ where: { id: data.referrerId } })); const c = await tx.client.update({ where: { id }, data }); await audit(tx, req.user.id, `Client ${c.status === 'archived' ? 'archivé' : 'modifié'} · ${c.name}`, 'clients', id, { clientId: id }); return c; }));
    app.get('/api/clients/:id', async (req) => found(await db.client.findUnique({ where: idParams.parse(req.params), include: { referrer: true, commissions: { include: { referrer: { select: { id: true, name: true } } }, orderBy: { date: 'desc' } }, quotes: { orderBy: { createdAt: 'desc' }, include: { items: true } }, projects: { include: { payments: true, items: true, tasks: true } }, invoices: { include: { payments: true } }, payments: { orderBy: { date: 'desc' } }, documents: true, subscriptions: true, activities: { orderBy: { createdAt: 'desc' }, take: 100 } } })));
    app.get('/api/services', async (req) => {
        const q = querySchema.parse(req.query);
        const where = { name: { contains: q.q }, ...(q.status === 'inactive' ? { active: false } : q.status === 'active' ? { active: true } : {}) };
        const [rows, count] = await Promise.all([db.service.findMany({ where, include: { category: true }, orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), db.service.count({ where })]);
        return { rows, count, page: q.page };
    });
    app.post('/api/services', async (req) => transaction(async (tx) => { const s = await tx.service.create({ data: serviceSchema.parse(req.body) }); await audit(tx, req.user.id, `Prestation créée · ${s.name}`, 'services', s.id); return s; }));
    app.patch('/api/services/:id', async (req) => transaction(async (tx) => { const s = await tx.service.update({ where: idParams.parse(req.params), data: serviceSchema.parse(req.body) }); await audit(tx, req.user.id, `Prestation modifiée · ${s.name}`, 'services', s.id); return s; }));
    app.get('/api/categories', async () => db.serviceCategory.findMany({ orderBy: { name: 'asc' } }));
    app.post('/api/categories', async (req) => db.serviceCategory.create({ data: z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body) }));
    app.patch('/api/categories/:id', async (req) => db.serviceCategory.update({ where: idParams.parse(req.params), data: z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body) }));
    app.get('/api/projects', async (req) => {
        const q = querySchema.parse(req.query);
        const where = { ...(q.status ? { status: q.status } : {}), OR: [{ title: { contains: q.q } }, { client: { name: { contains: q.q } } }] };
        const [rows, count] = await Promise.all([db.project.findMany({ where, include: { client: true, payments: true, tasks: true, items: true }, orderBy: { dueDate: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }), db.project.count({ where })]);
        return { rows, count, page: q.page };
    });
    app.get('/api/projects/:id', async (req) => found(await db.project.findUnique({ where: idParams.parse(req.params), include: { client: true, quote: true, items: { orderBy: { position: 'asc' } }, payments: { orderBy: { date: 'desc' } }, invoices: { include: { payments: true } }, documents: true, tasks: { orderBy: { position: 'asc' } }, subscriptions: true, activities: { orderBy: { createdAt: 'desc' }, take: 100 } } })));
    app.patch('/api/projects/:id', async (req) => transaction(async (tx) => { const data = projectPatch.parse(req.body); const old = found(await tx.project.findUnique({ where: idParams.parse(req.params) })); if ((data.dueDate ?? old.dueDate) < (data.startDate ?? old.startDate))
        throw new HttpError(400, 'Livraison antérieure au démarrage.'); const p = await tx.project.update({ where: { id: old.id }, data }); await audit(tx, req.user.id, `Projet mis à jour · ${p.title}`, 'projects', p.id, { clientId: p.clientId, projectId: p.id }); return p; }));
    app.post('/api/projects/:id/tasks', async (req) => transaction(async (tx) => { const { id } = idParams.parse(req.params); const p = found(await tx.project.findUnique({ where: { id } })); const b = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body); const task = await tx.task.create({ data: { projectId: id, title: b.title, position: await tx.task.count({ where: { projectId: id } }) } }); await audit(tx, req.user.id, `Étape ajoutée · ${b.title}`, 'projects', id, { projectId: id, clientId: p.clientId }); return task; }));
    app.patch('/api/tasks/:id', async (req) => transaction(async (tx) => { const task = await tx.task.update({ where: idParams.parse(req.params), data: z.object({ done: z.boolean().optional(), title: z.string().trim().min(1).max(200).optional() }).parse(req.body) }); await audit(tx, req.user.id, `Checklist · ${task.title}`, 'projects', task.projectId, { projectId: task.projectId }); return task; }));
    app.delete('/api/tasks/:id', async (req) => transaction(async (tx) => { const task = await tx.task.delete({ where: idParams.parse(req.params) }); await audit(tx, req.user.id, `Étape supprimée · ${task.title}`, 'projects', task.projectId, { projectId: task.projectId }); return { ok: true }; }));
    app.get('/api/expenses', async (req) => {
        const q = querySchema.parse(req.query);
        const where = { OR: [{ supplier: { contains: q.q } }, { category: { contains: q.q } }], ...(q.status ? { paid: q.status === 'paid' } : {}), date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } };
        const [rows, count] = await Promise.all([db.expense.findMany({ where, include: { documents: true }, orderBy: { date: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), db.expense.count({ where })]);
        return { rows, count, page: q.page };
    });
    app.get('/api/expenses/:id', async (req) => found(await db.expense.findUnique({ where: idParams.parse(req.params), include: { documents: true } })));
    app.post('/api/expenses', async (req) => transaction(async (tx) => { const data = expenseSchema.parse(req.body); const e = await tx.expense.create({ data: { ...data, totalCents: data.netCents + ratio(data.netCents, data.vatBps, 10000) } }); await audit(tx, req.user.id, `Dépense ajoutée · ${e.supplier}`, 'expenses', e.id); return e; }));
    app.patch('/api/expenses/:id', async (req) => transaction(async (tx) => { const data = expenseSchema.parse(req.body); const e = await tx.expense.update({ where: idParams.parse(req.params), data: { ...data, totalCents: data.netCents + ratio(data.netCents, data.vatBps, 10000) } }); await audit(tx, req.user.id, `Dépense modifiée · ${e.supplier}`, 'expenses', e.id); return e; }));
    app.delete('/api/expenses/:id', async (req) => transaction(async (tx) => { const { id } = idParams.parse(req.params); if (await tx.document.count({ where: { expenseId: id } }))
        throw new HttpError(409, 'Retirez d’abord les pièces jointes.'); await tx.expense.delete({ where: { id } }); await audit(tx, req.user.id, 'Dépense supprimée', 'expenses', id); return { ok: true }; }));
    app.get('/api/settings', async () => company());
    app.put('/api/settings', async (req) => transaction(async (tx) => { const data = settingsSchema.parse(req.body); if (data.logoDocumentId) {
        const doc = found(await tx.document.findUnique({ where: { id: data.logoDocumentId } }));
        if (!['image/png', 'image/jpeg'].includes(doc.mime))
            throw new HttpError(400, 'Le logo doit être une image PNG ou JPEG.');
    } await tx.settings.upsert({ where: { id: 'company' }, create: { id: 'company', data }, update: { data } }); await audit(tx, req.user.id, 'Paramètres entreprise modifiés', 'settings', 'company'); return data; }));
    app.get('/api/subscriptions', async () => db.subscription.findMany({ include: { client: true, project: true }, orderBy: { nextDate: 'asc' } }));
    app.post('/api/subscriptions/:id/invoice',async(req)=>transaction(async tx=>{
      const s=found(await tx.subscription.findUnique({where:idParams.parse(req.params),include:{client:true}}));
      if(!s.active)throw new HttpError(409,'Cet abonnement est arrêté.');
      const {nextDate}=z.object({nextDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).parse(req.body);
      if(nextDate!==s.nextDate)throw new HttpError(409,'Cette échéance a déjà été traitée. Actualisez la liste.');
      const settings=await company(tx),c=s.client;
      const invoice=await tx.invoice.create({data:{reference:`BRO-${randomUUID().slice(0,8).toUpperCase()}`,clientId:s.clientId,title:`${s.name} · ${s.nextDate}`,kind:'final',issuedDate:today(),dueDate:addDays(today(),30),totalCents:s.amountCents+ratio(s.amountCents,s.vatBps,10000),conditions:settings.conditions,legalNotice:settings.legalNotice,issuerSnapshot:settings,clientSnapshot:{name:c.name,contact:c.contact,email:c.email,address:c.address,phone:c.phone,siret:c.siret},items:{create:{name:s.name,description:`Abonnement ${s.frequency==='monthly'?'mensuel':'annuel'} - période débutant le ${s.nextDate}`,category:s.category,section:'Abonnement',quantityMilli:1000,unitCents:s.amountCents,vatBps:s.vatBps,frequency:'once'}}}});
      const d=new Date(s.nextDate+'T12:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+(s.frequency==='yearly'?12:1));const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));
      await tx.subscription.update({where:{id:s.id},data:{nextDate:d.toISOString().slice(0,10)}});
      await audit(tx,req.user.id,`Échéance préparée · ${s.name}`,'invoices',invoice.id,{clientId:s.clientId,invoiceId:invoice.id});return invoice;
    }));
    app.post('/api/subscriptions', async (req) => transaction(async (tx) => { const data = subscriptionSchema.parse(req.body); if (data.projectId) {
        const p = found(await tx.project.findUnique({ where: { id: data.projectId } }));
        if (p.clientId !== data.clientId)
            throw new HttpError(400, 'Le projet appartient à un autre client.');
    } const s = await tx.subscription.create({ data }); await audit(tx, req.user.id, `Abonnement créé · ${s.name}`, 'subscriptions', s.id, { clientId: s.clientId }); return s; }));
    app.patch('/api/subscriptions/:id', async (req) => transaction(async (tx) => { const b = z.object({ active: z.boolean(), nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body); const where = idParams.parse(req.params); if (b.nextDate !== undefined && b.nextDate < found(await tx.subscription.findUnique({ where })).nextDate)
        throw new HttpError(400, 'La prochaine échéance ne peut pas être antérieure à l’échéance actuelle.'); const s = await tx.subscription.update({ where, data: { ...b, endDate: b.active ? null : today() } }); await audit(tx, req.user.id, `Abonnement ${b.active ? 'activé' : 'arrêté'} · ${s.name}`, 'subscriptions', s.id, { clientId: s.clientId }); return s; }));
}
