# Corrections du 10 septembre 2026

Protections .env étendues à Git et Docker, log de démarrage structuré, Zod actualisé, compression des ressources statiques (API exclue), chargement différé du tableau de bord, titres de routes, consignes noindex, page 404, liens légaux et notice spécifique au studio, bouton de sauvegarde mobile persistant et contraste amélioré.

Mentions existantes : https://birostweb.fr/mentions-legales.html ; elles décrivent le site vitrine. La notice /confidentialite couvre le studio.

## Vérification
Build réussi ; 7 tests unitaires réussis. Audit npm à l’installation : zéro vulnérabilité connue.
Lighthouse exécuté sur la page de connexion du build local, sans authentification, avec Chromium headless :
- mobile: performance 96/100, accessibility 100/100, best-practices 92/100
- desktop: performance 99/100, accessibility 100/100, best-practices 92/100

Ces scores ne valident pas le VPS ni les pages authentifiées. Les tests d’intégration n’ont pas pu initialiser MySQL : daemon Docker indisponible et application Docker locale impossible à démarrer. Ils doivent être relancés après rétablissement de Docker avec `npm run test:integration`.

Restent à exécuter sur Dokploy : DNS/TLS du domaine réel, politique de reprise, sauvegarde du volume documentaire en complément de MySQL et restauration isolée. Voir DOKPLOY.md. Aucune configuration distante n’a été modifiée.

Références conservation : https://www.cnil.fr/fr/questions-reponses-sur-les-referentiels-relatifs-la-gestion-des-activites-commerciales-et-des et https://entreprendre.service-public.gouv.fr/vosdroits/F10029 . Les durées annoncées doivent être appliquées lors des revues des dossiers et archives.

# Corrections du 4 octobre 2026 (audit avant production)

- 2FA administrateur obligatoire (session limitée à l'enrôlement), réauthentification au setup, secrets TOTP chiffrés (AES-256-GCM, `TOTP_ENCRYPTION_KEY`), anti-rejeu par pas consommé atomiquement, 10 codes de secours hachés à usage unique, quotas par utilisateur sur 2FA/email, révocation des autres sessions après changement d'email ou de 2FA.
- Changement d'email : mot de passe + code 2FA. **Limite** : pas de preuve de possession de la nouvelle adresse (aucun service d'envoi d'emails dans l'application).
- Abby : verrou applicatif par facture, état de création durable (`creating → draft_created → lines_set → complete`) avec reprise sans doublon, confirmation explicite après création interrompue, finalisation refusée si incomplète, rapprochement limité aux factures finalisées non payées et au montant total.
- Webhook Cal.com : fenêtre de fraîcheur sur `createdAt` signé, ordre monotone (`lastEventAt`), annulation non réactivable par un ancien événement.
- Masquage des données personnelles/secrets dans les erreurs fournisseur et logs ; `TRUST_PROXY` accepte une liste d'IP/CIDR ; Dockerfile à copie minimale sans dépendances de dev, images épinglées par digest ; `npm audit fix` (fastify 5.12.5, fast-uri, brace-expansion).
- Tests : `npm test` (unitaires) et `npm run test:integration` sur base jetable `birostweb_test` (voir `tests/integration/security.test.js`, `abby-resume.test.js`).
