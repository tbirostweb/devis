# Déployer Birostweb sur Dokploy

Stack finale : Vue 3, JavaScript, Vite, API Fastify, Prisma et MySQL 8.4. Le Dockerfile à la racine sert l'application et l'API dans un seul conteneur. Aucun serveur Vite ne tourne en production.

## 1. Créer MySQL

Dans le projet Dokploy, créer un service MySQL 8.4 avec une base `birostweb` et un utilisateur dédié. Activer un volume de données et les sauvegardes. Utiliser le nom d'hôte interne donné par Dokploy dans `DATABASE_URL`. L'application et la base doivent partager le réseau privé. Ne pas exposer le port MySQL sur Internet.

## 2. Créer l'application

Connecter le dépôt Git contenant ce projet. Choisir **Dockerfile**, chemin `./Dockerfile`, contexte `.`. Ne définir aucune variable secrète comme argument de build : elles sont injectées seulement à l'exécution. Configurer un domaine HTTPS, par exemple `studio.votre-domaine.fr`, vers le port conteneur **3001**. Le service écoute sur `0.0.0.0`.

Variables à ajouter dans Dokploy (remplacer les valeurs d'exemple) :

```dotenv
NODE_ENV=production
PORT=3001
APP_ORIGIN=https://studio.votre-domaine.fr
DATABASE_URL=mysql://birostweb:MOT_DE_PASSE_ENCODE@HOTE_MYSQL_INTERNE:3306/birostweb
STORAGE_PATH=/app/storage
TRUST_PROXY=true
ADMIN_EMAIL=votre-email@birostweb.fr
ADMIN_PASSWORD=un-mot-de-passe-long-unique-de-14-caracteres-minimum
INITIALIZE_ADMIN=true
SEED_DEMO=false
```

Encoder les caractères réservés du mot de passe dans l'URL MySQL (par exemple `@` → `%40`, `#` → `%23`). `APP_ORIGIN` doit correspondre exactement à l'adresse HTTPS du navigateur, sans slash final. `TRUST_PROXY=true` suppose que seul le proxy Dokploy peut joindre le service : ne pas publier son port directement sur Internet. Une seule réplique applicative est prévue ; sessions persistées en MySQL, limitation des tentatives en mémoire du processus.

## 3. Persister les fichiers

Ajouter un **volume nommé** Dokploy monté sur `/app/storage`, inscriptible par l'utilisateur **UID/GID 1000**. Un bind mount de dossier hôte doit avoir le même propriétaire. Sans ce volume, les pièces jointes disparaîtraient à la recréation du conteneur. Le dossier n'est jamais servi comme un répertoire public.

## 4. Premier déploiement

Déployer. Le démarrage applique `prisma migrate deploy`, puis initialise le compte admin et le catalogue si `INITIALIZE_ADMIN=true`. Il ne remplace jamais le mot de passe d'un compte existant. Aucune donnée de démonstration n'est ajoutée en production.

Après la première connexion, passer `INITIALIZE_ADMIN=false` et retirer `ADMIN_PASSWORD` de Dokploy. Garder l'adresse de connexion en lieu sûr. Renseigner l'identité, l'adresse, le SIRET, les coordonnées bancaires et les mentions adaptées dans **Paramètres**. L'émission de facture requiert une adresse et un SIRET renseignés.

La vérification de santé Docker utilise `/api/health` et contrôle aussi l'accès à MySQL. Une réponse HTTP 200 est attendue. En cas d'échec des migrations, le démarrage s'arrête et expose la cause dans les journaux Dokploy.

## 5. Mise à jour et sauvegardes

Les déploiements suivants reconstruisent les assets et appliquent uniquement les migrations manquantes. Conserver les volumes MySQL et documents. Ne jamais exécuter `prisma migrate reset` en production.

Sauvegarder ensemble : (1) un dump MySQL cohérent avec `mysqldump --single-transaction --routines --triggers`, (2) le volume `/app/storage`, (3) la configuration des variables dans votre gestionnaire de secrets. Chiffrer les sauvegardes, conserver plusieurs générations et vérifier une restauration sur un environnement isolé. Dokploy permet de planifier les sauvegardes du service de base de données ; sauvegarder séparément le volume documentaire.

Avant une migration : sauvegarder, déployer une seule version à la fois, consulter les journaux et vérifier connexion, dossier client, PDF et pièce jointe. Le retour à une ancienne image ne restaure pas automatiquement le schéma MySQL ; prévoir une restauration si la migration est incompatible.

## Développement local

`docker-compose.yml` est également fourni pour MySQL local et, avec le profil `production`, un déploiement Compose. Le chemin recommandé dans Dokploy est le Dockerfile avec un service MySQL séparé. La version locale de démonstration possède sa propre base et des coordonnées fictives ; ne pas la copier dans la base de production.

## Références vérifiées

La configuration suit la documentation Dokploy : [connexion interne aux bases](https://docs.dokploy.com/docs/core/databases/connection), [volumes persistants](https://docs.dokploy.com/docs/core/applications/advanced) et [services et déploiements](https://docs.dokploy.com/docs/core/features).

## Contrôles avant ouverture du studio

- **DNS et TLS** : vérifier le domaine réel (A vers le VPS, AAAA cohérent si présent), la redirection HTTP vers HTTPS, la validité du certificat et son renouvellement. Ne pas confondre le domaine du site vitrine avec celui du studio.
- **Reprise** : dans le service Dokploy, contrôler la politique de redémarrage. Tester sur une préproduction l'arrêt du processus, puis une indisponibilité temporaire MySQL ; vérifier le retour à un état sain. La directive HEALTHCHECK du Dockerfile ne configure pas à elle seule la politique de reprise.
- **Sauvegardes** : programmer la sauvegarde du volume documentaire en complément du backup MySQL, avec une rétention définie, chiffrement et copie hors VPS. Pour une sauvegarde cohérente, suspendre les écritures le temps de capturer la DB et le volume. Restaurer les deux sur une instance isolée puis ouvrir une facture et télécharger une pièce jointe. Ne jamais tester une restauration sur la production.
- **Confidentialité** : remettre aux clients le lien `/confidentialite` avec les devis ou lors de la collecte ; une notice uniquement visible par l'administrateur ne suffit pas à les informer. Appliquer les durées annoncées via une revue régulière des dossiers et archives, y compris des sauvegardes. Configurer également la rotation et une conservation limitée des logs Dokploy ; ne pas y enregistrer les corps des requêtes contenant les dossiers clients.

Les vérifications DNS/TLS, sauvegarde/restauration et reprise nécessitent l'accès à l'instance réelle. Elles ne sont pas attestées par les tests locaux.
