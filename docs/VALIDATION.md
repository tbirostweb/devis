# Validation locale — 9 septembre 2026

- 7 tests unitaires réussis : centimes et arrondis, remises avant TVA, options, séparation du récurrent, limites financières, dates civiles et absence de double comptage des paiements.
- 12 tests d'intégration réussis dans la base isolée `birostweb_test` : authentification/CSRF/Origin, CRUD, snapshots, conversion concurrente, émission et numérotation, dépassement de solde, idempotence des paiements, fichiers privés et faux MIME, abonnements/TVA/fins de mois, reporting/recherche/notifications, PDF, affectation d'un paiement existant et archivage.
- Construction Vite réussie ; contrôles HTTP réussis sur les routes de données, dont recherche et factures paginées par statut.
- Rendu PDF vérifié visuellement : facture sur 1 page et devis de 28 prestations sur 6 pages. Les 7 pages de contrôle ont été inspectées : aucune page blanche ou collision de contenu/footer constatée. Polices IBM Plex incorporées en TrueType.
- Image Docker construite et démarrée réellement en mode production sur Docker Desktop Linux ARM64. Migrations et initialisation admin réussies, santé `healthy`, processus UID 1000, routes SPA/API opérationnelles, cookies `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, document écrit puis relu dans le volume privé.
- Absence de `.env` et d'`ACCES-LOCAL.md` dans l'image vérifiée. Audit npm : zéro vulnérabilité signalée à la date du contrôle.

Limites de cette validation : aucun déploiement sur votre instance Dokploy, aucune restauration de sauvegarde sur votre VPS, aucune recette interactive automatisée du navigateur. Le Dockerfile utilise des images multi-architecture, mais seul ARM64 a été exécuté ici. Les contrôles ne constituent pas une certification de conformité comptable.
