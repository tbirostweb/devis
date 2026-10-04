// Ne purge jamais les factures, contrats, devis, paiements ou justificatifs comptables.
export async function purgeTechnicalData(db, now = new Date()) {
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    return db.$transaction(async tx => ({
        sessions: (await tx.session.deleteMany({where:{expiresAt:{lt:now}}})).count,
        notifications: (await tx.notification.deleteMany({where:{readAt:{lt:cutoff}}})).count,
        activity: (await tx.activityLog.deleteMany({where:{createdAt:{lt:cutoff}, clientId:null, quoteId:null, projectId:null, invoiceId:null}})).count,
    }));
}
export function scheduleRetention(db, logger) {
    let running = false;
    const run = async () => { if(running)return; running=true; try {await purgeTechnicalData(db);} catch {logger.error('Purge technique échouée');} finally {running=false;} };
    const timer=setInterval(run, 86400000); timer.unref(); run(); return () => clearInterval(timer);
}
