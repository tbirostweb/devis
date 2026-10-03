# Birostweb — conception, 9 septembre 2026

## Besoin et priorités UX
Outil privé mono-administrateur, organisé autour d'un dossier client et de sa chaîne commerciale. La vue d'ensemble répond immédiatement à trois questions : argent encaissé, travail en cours, actions à effectuer. Les clients et prospects partagent un référentiel. Les devis sont des engagements figés après envoi ; le catalogue demeure modifiable. Les paiements enregistrés constituent la source des encaissements. La facturation et les encaissements sont distingués.

## Analyse graphique
Source : HTML public de https://birostweb.fr/ et section #offres, consultés le 09/09/2026. Tokens observés : paper #E5E2D6, surface #FBFAF6, ink #231F20, accent #F0451E, accent hover #CE3711, gray #6E6A5F, line #CFCABC. Polices auto-hébergées IBM Plex Sans Condensed (titres), Sans (lecture), Mono (annotations). Source locale des mêmes polices : projet birostweb voisin.

La référence jointe présente une composition éditoriale à grands titres, chiffres surdimensionnés, colonnes asymétriques et cadres fins. Adaptation : barre latérale sombre, surface claire, titre condensé, quatre indicateurs intégrés dans une grille, graphique large et panneau d'actions. Pas de photographie décorative dans cet outil métier. Angles de 0 à 4 px, filets de 1 px, transitions de 150 ms ; accent réservé aux actions et indicateurs prioritaires. Textes courants 16 px, contrôles 14 px, métadonnées 12 px minimum.

Le catalogue initial reprend les offres du site. Essentiel 45 €/mois et Pro 69 €/mois incluent déjà sécurité, mises à jour et sauvegardes. La maintenance indépendante de 39 €/mois est présentée comme adaptée à l'hébergement du client. Aucun prix n'est codé dans les composants.

## Architecture
Vue 3, Vue Router, Vite, JavaScript ESM (préférence confirmée le 09/09/2026) ; API Fastify avec Zod, Prisma et MySQL 8.4 LTS. Monolithe modulaire pour limiter l'exploitation sur VPS : un conteneur applicatif sert les assets et l'API, un conteneur MySQL et un volume privé de documents. En développement, Vite relaie /api vers Fastify. L'hébergement VPS demandé guide l'architecture ; aucune dépendance au runtime Cloudflare de Sites.

Arborescence : src/components pour les primitives, src/views pour les écrans, src/lib pour les appels et formats ; shared pour les contrats et calculs monétaires ; server/routes pour les contrôleurs, server pour sécurité et accès aux données ; prisma pour schéma, migrations et seed ; tests pour calculs et workflows API. L'envoi email pourra être ajouté derrière un service de livraison sans modifier les devis.

## Schéma relationnel
User 1—N Session, ActivityLog. Client 1—N Quote, Project, Invoice, Payment, Subscription, Document. ServiceCategory 1—N Service. Quote 1—N QuoteItem et 0—1 Project. Project 1—N ProjectItem, Invoice, Payment, Task, Document. Invoice 1—N InvoiceItem, Payment, Document. Expense 1—N Document. Les documents peuvent référencer Client, Quote, Project, Invoice ou Expense. Notification appartient à User ; ActivityLog conserve acteur, action et liens métier. Settings stocke l'identité d'entreprise ; Counter réserve atomiquement la numérotation annuelle.

Tous les montants sont des entiers en centimes, les quantités en millièmes et les taux en points de base. Les lignes de devis, projet et facture conservent nom, description, prix, catégorie, fréquence, quantité, remise et TVA historiques. Relations protégées, indexes sur client/date/statut, interdiction des montants négatifs. Dates civiles sous forme YYYY-MM-DD et instants techniques UTC. Les dates de reporting sont évaluées en Europe/Paris.

## Écrans
Connexion ; Vue d'ensemble ; Clients (liste, fiche, création/édition, archivage) ; Devis (liste, builder, détail, PDF) ; Projets (liste, cartes/Kanban, fiche à onglets) ; Factures clients ; Dépenses ; Prestations et catégories ; Documents ; Calendrier (mois, jour, année/archives) ; Finances (encaissements, dépenses, récurrent) ; Paramètres. Recherche globale Ctrl/Cmd K et centre de notifications dans l'en-tête.

## Workflows
1. Prospect/client → choix des prestations → options et récurrent séparés → remise/TVA/acompte → enregistrement brouillon → PDF → statut envoyé (envoi externe manuel) → accepté → conversion transactionnelle et idempotente en projet.
2. Projet → checklist, statuts, notes → facture d'acompte/intermédiaire/finale → paiement lié à la facture → total payé et solde calculés, sans double comptage.
3. Dépense → saisie fournisseur et montants → téléversement contrôlé PDF/JPEG/PNG → stockage privé → consultation depuis mois, fournisseur ou dossier.
4. Abonnement issu du projet ou saisi dans Finances → MRR/ARR calculés pour contrats actifs → arrêt explicite. Les factures récurrentes sont créées à la demande pour éviter l'émission automatique non souhaitée.
5. Toute mutation importante crée une entrée d'audit dans la même transaction. Les alertes sont dérivées des échéances et disposent d'un état de lecture persistant.

## Sécurité et exploitation
Mot de passe Argon2id ; sessions opaques aléatoires, seul leur hash en base ; cookie HttpOnly, SameSite=Lax et Secure en production ; CSRF avec jeton et validation Origin ; expiration, révocation et limitation des tentatives par IP et identifiant. Toutes les routes métier et fichiers passent par l'authentification. Validation Zod côté client et serveur. Téléversement de 10 Mo maximum, identification du contenu, noms aléatoires hors répertoire public, téléchargement authentifié. Aucun mode démo anonyme en production. Secrets injectés par environnement ; bootstrap admin explicite ; démo facultative et interdite en production.

Les factures émises conservent les coordonnées de l'émetteur et du client. Les avoirs et intégrations de facturation électronique constituent des extensions métier à traiter avant un usage qui les requiert ; ne pas présenter ce logiciel comme un service de conformité comptable certifié. Sauvegardes MySQL et documents documentées, restauration à tester sur le VPS cible.
