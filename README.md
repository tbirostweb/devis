# Birostweb · Espace studio

Application privée de gestion freelance : Vue 3 **JavaScript**, Vite, API Node.js/Fastify, Prisma et **MySQL 8.4**. Tous les dossiers sont enregistrés en base ; les justificatifs sont stockés dans un volume privé.

## Démarrage local

Prérequis : Node 22 et Docker.

```sh
cp .env.example .env
# Définir les mots de passe MySQL, DATABASE_URL, ADMIN_EMAIL et ADMIN_PASSWORD.
npm ci
docker compose up -d db
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Ouvrir http://127.0.0.1:5184 et se connecter avec le compte de `.env`. L'API utilise le port 3001. Le catalogue initial reprend les offres publiques Birostweb ; `SEED_DEMO=true` ajoute des dossiers fictifs. Le seed est idempotent et ne remplace jamais le mot de passe existant. Le dossier déjà préparé contient son `.env` local, qui reste exclu de Git et Docker.

## Dokploy

Le [guide Dokploy](docs/DOKPLOY.md) décrit le déploiement avec le [Dockerfile](Dockerfile), un service MySQL séparé, les variables, le domaine HTTPS, le volume `/app/storage`, les migrations automatiques et le premier compte administrateur. Le port interne est **3001**. Les données de démonstration sont désactivées en production.

## Fonctionnalités

- Connexion Argon2id, sessions MySQL, cookies HttpOnly/Secure en production, CSRF, vérification Origin, limitation des tentatives, déconnexion et changement de mot de passe.
- Dashboard calculé sur les données, courbe des encaissements, dépenses, chiffre d'affaires facturé HT, soldes, conversion, projets, MRR/ARR et échéances.
- Clients/prospects : création, modification, recherche, statut, archivage et fiche centralisée.
- Catalogue : prestations, catégories, prix, fréquence, maintenance incluse, prix indicatifs et activation.
- Builder devis : lignes catalogue/personnalisées, quantités fractionnaires, sections et ordre, TVA, remises, options, acompte, notes, conditions, création de client inline, Cmd/Ctrl S.
- PDF devis/facture avec coordonnées historiques, logo facultatif, polices IBM Plex, calculs et pagination. Les devis émis se révisent par duplication.
- Conversion transactionnelle et idempotente devis accepté → projet. Vues liste/cartes/Kanban, statuts, dates, checklist, notes, documents et audit.
- Factures manuelles ou liées à un devis/projet ; acompte/intermédiaire/finale. Numéro définitif à l'émission. Montants plafonnés au solde à facturer. Les factures émises sont figées.
- Paiements manuels avec contrôles de cohérence, clé anti-doublon, protection transactionnelle contre le dépassement de solde et statut de facture calculé.
- Dépenses/fournisseurs : HT/TVA/TTC, catégories, paiement et justificatifs PDF/PNG/JPG jusqu'à 10 Mo ; contrôle du type réel, stockage et téléchargement authentifiés.
- Calendrier jour/mois/année, archives des factures par date, recherche globale Cmd/Ctrl K, notifications d'échéance avec lecture persistée.
- Abonnements mensuels/annuels : MRR/ARR HT, arrêt/réactivation, création manuelle du brouillon d'échéance avec TVA et passage à la date suivante.
- Export CSV des listes et des encaissements. Interface responsive et polices auto-hébergées.

## Architecture et données

Voir [l'analyse UX, visuelle et technique](docs/CONCEPTION.md) et [le schéma Prisma](prisma/schema.prisma). Les montants sont en centimes, quantités en millièmes et taux en points de base ; les calculs emploient BigInt avant arrondi. Les lignes de devis, projet et facture sont des snapshots autonomes. Les routes font une validation Zod. Les opérations financières et audit sont regroupés en transactions sérialisables avec reprise des conflits.

`src/views` contient les écrans ; `src/components` les composants communs ; `shared` les contrats et calculs ; `server/routes` les domaines API ; `prisma/migrations` les migrations MySQL versionnées. Les routes métier sont privées. Les fichiers ne sont jamais servis directement par le serveur statique.

## Validation

```sh
npm test
npm run build
npm run test:integration
docker build -t birostweb-studio .
```

Les tests d'intégration exigent une base **distincte** appelée `birostweb_test`, accessible avec le compte MySQL local (ou `TEST_DATABASE_URL`). Ils refusent une autre base et la réinitialisent. Ils lancent leur API sur 3202 et couvrent authentification, CSRF, catalogue, snapshots, conversions concurrentes, plafonds financiers, numérotation, paiements concurrents, pièces jointes, récurrent, reporting et PDF. Les PDF de contrôle sont écrits dans `tmp/pdfs`, exclu du dépôt.

## Périmètre d'exploitation

L'envoi email reste manuel : « Marquer envoyé » enregistre une action déclarée, il n'expédie aucun email ; « Vu » est aussi renseigné manuellement. Les échéances récurrentes produisent des brouillons uniquement sur action de l'administrateur. Aucune signature électronique, lecture email automatique, OCR, import bancaire, paiement en ligne, avoir ou connecteur de facturation électronique n'est intégré.

Les indicateurs de trésorerie sont des estimations, distinctes du résultat comptable après cotisations et impôts. Les conditions et mentions doivent être renseignées pour votre activité. Un acompte payé avant l'émission d'une facture peut être affecté ensuite à celle-ci depuis sa fiche, sans enregistrer un second paiement. Les montants non affectés restent visibles dans les encaissements du projet.

Le déploiement et la restauration sont à valider sur le VPS cible ; aucun serveur Dokploy n'a été modifié depuis ce projet. Les fichiers et la base doivent être sauvegardés ensemble. Utiliser une seule réplique applicative avec le stockage actuel et la limitation des tentatives en mémoire.

## Purge technique sur autorisation

La maintenance de rétention est désactivée par défaut : `RETENTION_ENABLED=false` ou variable absente. Un déploiement ne supprime donc pas les anciens enregistrements via ce job. Après sauvegarde restaurable et autorisation explicite de purge, `RETENTION_ENABLED=true` active la purge technique au démarrage puis quotidiennement. Factures, contrats, devis, paiements et justificatifs restent exclus.
