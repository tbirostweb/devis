import argon2 from 'argon2';
import { z } from 'zod';
import { db, transaction, audit, found, HttpError, today } from '../db.js';
import { userCreateSchema, userPatchSchema, referrerSelfSchema } from '../../shared/contracts.js';
import { isPwned } from '../pwned.js';
const idParams = z.object({ id: z.string().min(1) });
const hashParams = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, referrerId: u.referrerId, referrer: u.referrer ? { id: u.referrer.id, name: u.referrer.name } : null, totpEnabled: u.totpEnabled, createdAt: u.createdAt });
const linkReferrer = async (tx, role, referrerId) => {
    if (role !== 'referrer') return null;
    const r = found(await tx.referrer.findUnique({ where: { id: referrerId } }));
    if (r.status === 'archived') throw new HttpError(400, 'Cet apporteur est archivé.');
    return r.id;
};
export async function team(app) {
    // Gestion des comptes — réservée aux administrateurs (garantie par le garde-fou d'auth).
    app.get('/api/users', async () => (await db.user.findMany({ include: { referrer: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } })).map(publicUser));
    app.post('/api/users', async (req) => {
        const b = userCreateSchema.parse(req.body);
        // Contrôle réseau (HIBP) et hachage argon2 hors transaction : ni l'un ni l'autre
        // ne doit maintenir la base verrouillée ni pouvoir figer la requête.
        if (await isPwned(b.password))
            throw new HttpError(400, 'Ce mot de passe figure dans une fuite de données connue. Choisissez-en un autre.');
        const passwordHash = await argon2.hash(b.password, hashParams);
        return transaction(async (tx) => {
            if (await tx.user.findUnique({ where: { email: b.email } }))
                throw new HttpError(409, 'Un compte existe déjà avec cet email.');
            const referrerId = await linkReferrer(tx, b.role, b.referrerId);
            const user = await tx.user.create({ data: { name: b.name, email: b.email, role: b.role, referrerId, passwordHash }, include: { referrer: { select: { id: true, name: true } } } });
            await audit(tx, req.user.id, `Compte créé · ${user.email} (${user.role === 'admin' ? 'administrateur' : 'apporteur'})`, 'users', user.id);
            return publicUser(user);
        });
    });
    app.patch('/api/users/:id', async (req) => transaction(async (tx) => {
        const { id } = idParams.parse(req.params);
        const target = found(await tx.user.findUnique({ where: { id } }));
        const b = userPatchSchema.parse(req.body);
        const role = b.role ?? target.role;
        // Ne jamais se rétrograder soi-même ni retirer le dernier administrateur.
        if (target.role === 'admin' && role !== 'admin') {
            if (id === req.user.id) throw new HttpError(409, 'Vous ne pouvez pas retirer votre propre accès administrateur.');
            if (await tx.user.count({ where: { role: 'admin' } }) <= 1) throw new HttpError(409, 'Conservez au moins un administrateur.');
        }
        const referrerId = role === 'referrer' ? await linkReferrer(tx, role, b.referrerId ?? target.referrerId) : null;
        const user = await tx.user.update({ where: { id }, data: { ...(b.name ? { name: b.name } : {}), role, referrerId }, include: { referrer: { select: { id: true, name: true } } } });
        if (role !== target.role || referrerId !== target.referrerId)
            await tx.session.deleteMany({ where: { userId: id } });
        await audit(tx, req.user.id, `Compte modifié · ${user.email}`, 'users', user.id);
        return publicUser(user);
    }));
    app.delete('/api/users/:id', async (req) => transaction(async (tx) => {
        const { id } = idParams.parse(req.params);
        if (id === req.user.id) throw new HttpError(409, 'Vous ne pouvez pas supprimer votre propre compte.');
        const target = found(await tx.user.findUnique({ where: { id } }));
        if (target.role === 'admin' && await tx.user.count({ where: { role: 'admin' } }) <= 1)
            throw new HttpError(409, 'Conservez au moins un administrateur.');
        await tx.user.delete({ where: { id } });
        await audit(tx, req.user.id, `Compte supprimé · ${target.email}`, 'users', id);
        return { ok: true };
    }));
    // Espace apporteur — lecture seule, strictement limité à ses propres données.
    app.get('/api/portal', async (req) => {
        if (req.user.role === 'admin')
            throw new HttpError(400, 'Cet espace est réservé aux comptes apporteurs.');
        const referrer = found(await db.referrer.findUnique({ where: { id: req.user.referrerId ?? '' }, include: { commissions: { include: { client: { select: { name: true } } }, orderBy: { date: 'desc' } }, clients: { select: { name: true, status: true }, orderBy: { name: 'asc' } } } }));
        const year = today().slice(0, 4);
        const sum = keep => referrer.commissions.filter(keep).reduce((n, c) => n + c.amountCents, 0);
        return {
            referrer: { name: referrer.name, status: referrer.status, conventionDate: referrer.conventionDate, email: referrer.email, phone: referrer.phone, address: referrer.address, siret: referrer.siret, iban: referrer.iban, notes: referrer.notes },
            stats: { awaitingCents: sum(c => c.status === 'awaiting'), dueCents: sum(c => c.status === 'due'), settledCents: sum(c => c.status === 'settled'), paidYearCents: sum(c => c.status === 'settled' && c.paidDate?.startsWith(year)) },
            commissions: referrer.commissions.map(c => ({ id: c.id, label: c.label, clientName: c.client.name, baseCents: c.baseCents, rateBps: c.rateBps, amountCents: c.amountCents, status: c.status, date: c.date, paidDate: c.paidDate })),
            clients: referrer.clients
        };
    });
    // L'apporteur remplit et corrige sa propre fiche — coordonnées et informations de paiement,
    // strictement limité à son enregistrement. Le statut (occasionnel/régulier) reste géré par l'administrateur.
    app.patch('/api/portal/profile', async (req) => transaction(async (tx) => {
        if (req.user.role === 'admin' || !req.user.referrerId)
            throw new HttpError(400, 'Cet espace est réservé aux comptes apporteurs.');
        const b = referrerSelfSchema.parse(req.body);
        const current = found(await tx.referrer.findUnique({ where: { id: req.user.referrerId } }));
        if (current.status === 'regular' && !/^\d{14}$/.test(b.siret))
            throw new HttpError(400, 'Votre statut « régulier » impose un SIRET à 14 chiffres.');
        const r = await tx.referrer.update({ where: { id: current.id }, data: b });
        await audit(tx, req.user.id, `Fiche apporteur mise à jour · ${r.name}`, 'referrers', r.id);
        return { ok: true };
    }));
}
