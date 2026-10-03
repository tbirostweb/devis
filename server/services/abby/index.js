// Point d'entrée de la couche Abby : fournit le service configuré depuis l'env.
// En production, utilise le vrai fetch. En test/e2e (ABBY_MOCK=1), bascule sur un
// mock en mémoire — aucun appel réseau, aucune donnée écrite dans le compte Abby.

import { createAbbyHttp, AbbyError } from './http.js';
import { createAbbyService, buildAbbyLines, vatCodeFor, vatMentionFor, readInvoiceSync, assertFinalizable } from './service.js';
import { createMockFetch } from './mock.js';

let cached;

export function abbyEnabled() {
    return process.env.ABBY_ENABLED !== 'false' && !!process.env.ABBY_API_KEY;
}

// Service partagé. `override` permet l'injection d'un faux http/service en test.
export function getAbbyService(override) {
    if (override) return override;
    if (cached) return cached;
    const fetchImpl = process.env.ABBY_MOCK === '1' ? createMockFetch() : globalThis.fetch;
    const http = createAbbyHttp({ fetch: fetchImpl });
    cached = createAbbyService(http);
    return cached;
}

export function resetAbbyService() { cached = undefined; }

export { AbbyError, createAbbyHttp, createAbbyService, buildAbbyLines, vatCodeFor, vatMentionFor, readInvoiceSync, assertFinalizable, createMockFetch };
