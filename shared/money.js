// Integer arithmetic: half-up rounding to the cent, never binary fractional money.
export function ratio(amount, numerator, denominator) {
    if (![amount,numerator,denominator].every(Number.isSafeInteger)||amount<0||numerator<0||denominator<=0)throw new Error('Calcul monétaire invalide.');
    const result = (BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
    if (result > BigInt(2_000_000_000))
        throw new Error('Montant trop élevé.');
    return Number(result);
}
export function lineTotal(item, discountBps = 0) {
    if (![item.discountBps,item.vatBps,discountBps].every(v=>Number.isInteger(v)&&v>=0&&v<=10000)||!Number.isInteger(item.quantityMilli)||item.quantityMilli<=0)throw new Error('Quantité, TVA ou remise invalide.');
    const gross = ratio(item.unitCents, item.quantityMilli, 1000);
    const afterLine = gross - ratio(gross, item.discountBps, 10000);
    const net = afterLine - ratio(afterLine, discountBps, 10000);
    const tax = ratio(net, item.vatBps, 10000);
    return { gross, net, tax, total: net + tax, discount: gross - net };
}
export function totals(items, discountBps = 0, depositBps = 3000) {
    if (![discountBps,depositBps].every(v=>Number.isInteger(v)&&v>=0&&v<=10000))throw new Error('Les pourcentages doivent être compris entre 0 et 100.');
    let subtotal = 0, discount = 0, net = 0, tax = 0, monthly = 0, yearly = 0;
    for (const item of items.filter(i => !i.optional || i.selected)) {
        const sum = lineTotal(item, discountBps);
        if (item.frequency === 'monthly')
            monthly += sum.total;
        else if (item.frequency === 'yearly')
            yearly += sum.total;
        else {
            subtotal += sum.gross;
            discount += sum.discount;
            net += sum.net;
            tax += sum.tax;
        }
    }
    const total = net + tax;
    if ([total, monthly, yearly].some(v => v > 2_000_000_000))
        throw new Error('Montant trop élevé.');
    const deposit = ratio(total, depositBps, 10000);
    return { subtotal, discount, net, tax, total, monthly, yearly, mrr: monthly + ratio(yearly, 1, 12), deposit, remaining: total - deposit };
}
export function eurosToCents(value) {
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim()))
        throw new Error('Montant invalide (2 décimales maximum).');
    const [whole, fractional = ''] = value.trim().replace(',', '.').split('.');
    const cents = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents > 2_000_000_000)
        throw new Error('Montant trop élevé.');
    return cents;
}
// Apport d'affaires : le taux dépend de l'assiette, c'est-à-dire du montant HT
// réellement encaissé par le studio. Tranches exclusives, sans chevauchement.
export const COMMISSION_TIERS = [{ maxCents: 99_999, bps: 800 }, { maxCents: 200_000, bps: 900 }, { maxCents: null, bps: 1000 }];
// DAS2 : seuil annuel par bénéficiaire au-delà duquel la déclaration est due.
export const DAS2_THRESHOLD_CENTS = 240_000;
export function commissionRate(baseCents) {
    if (!Number.isSafeInteger(baseCents) || baseCents < 0)
        throw new Error('Assiette de commission invalide.');
    return COMMISSION_TIERS.find(t => t.maxCents === null || baseCents <= t.maxCents).bps;
}
export function commissionAmount(baseCents, rateBps) {
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000)
        throw new Error('Taux de commission invalide.');
    return ratio(baseCents, rateBps, 10000);
}
