# Guide d'utilisation — tenir les comptes dans Birostweb

Comment remplir l'application au quotidien, écran par écran, en suivant le parcours réel d'une affaire : du prospect à l'encaissement, jusqu'aux commissions et aux dépenses. Ce guide décrit ce que fait le logiciel ; il ne remplace pas l'avis d'un expert-comptable ou du SIE pour les cas particuliers (voir *Guide administratif 2026* et la section « Ce que l'application ne fait pas »).

---

## 0. Avant tout : les Paramètres (une fois pour toutes)

Menu latéral → **Paramètres**. Rien ne peut être facturé proprement tant que cette page n'est pas complète.

- **01 / Identité** — Nom commercial, nom de l'entrepreneur, **adresse complète**, email, téléphone, **SIRET (14 chiffres)**, **IBAN**, logo (PNG/JPG). L'adresse et le SIRET sont **obligatoires pour émettre une facture** : sans eux, l'émission est refusée.
- **02 / Devis** — Durée de **validité** par défaut (jours) et **acompte par défaut (%)**. Ces valeurs pré-remplissent chaque nouveau devis, modifiables au cas par cas.
- **03 / Facturation** — **Préfixe des factures** (ex. `FAC`) et **mentions légales**. Le numéro se construit tout seul à l'émission : `FAC-2026-001`, `002`… Le compteur repart à 1 chaque année.
- **04 / Sécurité** — Changement de mot de passe (14 caractères minimum ; toutes les sessions sont fermées ensuite).

**Mentions légales — points à régler ici une fois :**
- **Franchise en base de TVA** : mettez dans *Mentions légales* une formule officielle, par ex. `TVA non applicable, art. 293 B du CGI` (l'administration cite aussi désormais `art. L. 223-3 du CIBS`).
- **Clients professionnels** : le texte des **pénalités de retard** et de l'**indemnité forfaitaire de 40 €** est pré-rempli dans le champ *Mentions B2B — pénalités de retard* (modifiable). Il ne s'imprime que sur les devis/factures dont la case « client professionnel » est cochée (voir §3 et §5).

> Les documents déjà émis conservent leurs informations d'origine : modifier les paramètres n'affecte que les **nouveaux** documents.

---

## 1. Le client (ou prospect)

Menu → **Clients** → *Ajouter un client*.

- Entreprise/nom, contact, email, téléphone, adresse, SIRET, **statut** (Prospect / Actif / Archivé).
- **Apporté par** : si quelqu'un vous a mis en relation, sélectionnez l'apporteur. Les futures commissions se rattacheront à cette relation (voir §8).

Un client passe automatiquement en **Actif** dès qu'un devis accepté est converti en projet. La fiche client rassemble projets, devis, factures, paiements, documents, notes et l'historique complet des actions.

---

## 2. Le catalogue de prestations

Menu → **Prestations**. C'est votre bibliothèque de tarifs, réutilisée dans les devis.

- Nom, catégorie (ou nouvelle catégorie), description, **prix HT**, tarification (fixe / horaire / sur devis), **fréquence** (unique / mensuelle / annuelle), prix indicatif, active, « maintenance incluse ».
- Modifier un tarif n'affecte **pas** les devis déjà établis : ils gardent leur prix historique.

---

## 3. Le devis — avant de travailler

Menu → **Devis** → *Créer un devis* (éditeur en trois blocs, sauvegarde par ⌘S).

1. **Le contexte** — client (ou *Nouveau client* à la volée), objet, date d'émission, **valable jusqu'au**.
2. **Le périmètre** — ajoutez des prestations depuis le catalogue ou une **ligne personnalisée**. Par ligne : quantité, **prix HT**, remise %, **TVA %**, fréquence, description, section, et **option facultative** (incluse ou non dans le total). Réordonnez avec les flèches.
3. **Les conditions** — remise globale, **acompte %**, **délai estimé**, conditions de paiement, mentions légales, notes internes (non imprimées).

Le récapitulatif de droite calcule en direct : sous-total HT, remises, TVA, **total TTC**, acompte, solde, et le **récurrent** (mensuel/annuel) séparé du projet.

**Correspondance avec la checklist « devis » du guide administratif :**

| À faire figurer | Où, dans Birostweb |
| --- | --- |
| Numéro + date | Référence `DEV-2026-001` et date, automatiques |
| Identité pro (nom, adresse, SIRET) | Paramètres → bloc Émetteur du PDF |
| Identité + adresse client | Fiche client → bloc Client du PDF |
| Description précise, quantité, PU, HT/TTC | Lignes de prestations |
| TVA (taux/montant) ou mention de franchise | TVA par ligne + Mentions légales |
| Délai / validité | Délai estimé + Valable jusqu'au |
| Acompte | Acompte % |
| Ce qui n'est **pas** inclus | Options « non retenues », description, conditions |
| Révisions incluses / tarif hors-périmètre | À écrire dans la description ou les conditions (pas de champ dédié) |
| Renvoi vers vos CGV | À écrire dans *Conditions de paiement* (pas de champ dédié) |

Le **PDF** (bouton après enregistrement) porte une ligne **« Bon pour accord - date et signature du client »** : c'est votre preuve d'acceptation.

### Cycle de vie et acceptation
Brouillon → **Envoyé** → Vu → **Accepté** / Refusé (Expiré si la validité est dépassée). Seul un **brouillon** est modifiable ; pour réviser un devis déjà envoyé, **dupliquez-le** (bouton *Dupliquer*) plutôt que de changer le prix — c'est l'équivalent d'un avenant. Chaque changement de statut est horodaté dans l'historique.

---

## 4. Du devis au projet

Sur un devis **accepté** : *Créer le projet* (ou Devis → *Nouveau projet*). Le projet reprend prestations, prix, options et notes, et crée :
- une **checklist** (Maquette, Développement, Validation client, Mise en production, Facture finale) — cochez au fil de l'eau, l'avancement se calcule tout seul ;
- un **abonnement** par ligne récurrente (hébergement, maintenance…), visible ensuite dans Finances.

Tout supplément hors périmètre = **nouveau devis**, pas une modification du projet.

---

## 5. Les factures — après la vente

Depuis un projet : *Créer une facture*. **Type de facture** : Acompte / Intermédiaire / Finale.
- Une facture d'acompte reprend le pourcentage d'acompte ; une facture liée à un projet ne peut pas dépasser le **reste à facturer** (contrôle automatique).
- Une facture ne porte que des **lignes uniques** (pas de récurrent : le récurrent, ce sont les abonnements).

**Client professionnel (B2B)** : cochez *Client professionnel* dans l'éditeur (bloc 03) pour imprimer les pénalités de retard et l'indemnité de 40 € — obligatoire en B2B. La case est **décochée par défaut** ; laissez-la décochée pour un particulier. Le texte vient des *Mentions B2B* des Paramètres.

### Émettre une facture
Une facture naît en **brouillon** (référence provisoire `BRO-…`). *Émettre la facture* attribue le **numéro définitif séquentiel** (`FAC-2026-001`) et fige le document. L'émission vérifie :
- adresse et SIRET renseignés dans les Paramètres ;
- date d'émission **pas dans le futur** ;
- **chronologie** respectée par rapport aux factures déjà émises.

> Une facture émise est **immuable** : ni modification, ni suppression, ni réemploi de numéro. Pour l'annuler, passez-la en **Annulée** (elle est conservée). Il n'existe pas encore d'**avoir**/facture rectificative dans l'application (voir limites).

---

## 6. Les encaissements

Menu → **Finances** → *Enregistrer un paiement*, ou depuis une facture / un projet.
- Rattachez le paiement à une **facture** (le montant restant se pré-remplit) ou directement à un **projet**.
- Un paiement ne peut pas dépasser le solde dû (contrôle automatique) ni être daté dans le futur.
- Un paiement déjà reçu sur un projet peut être **affecté** à une facture ultérieure sans double comptage (bouton *Affecter à cette facture*).

Le **statut** d'une facture émise (Envoyée / Paiement partiel / Payée / En retard) découle des paiements enregistrés : il n'est jamais saisi à la main.

---

## 7. Les abonnements (revenu récurrent)

Menu → **Finances** → section *Les abonnements*. Créés automatiquement à la conversion d'un devis, ou ajoutés à la main. Ils alimentent le **MRR** (mensuel) et l'**ARR** (annuel estimé).
- *Facturer* génère un **brouillon de facture** pour l'échéance en cours et avance la prochaine échéance. Rien n'est émis automatiquement : vous gardez la main.
- *Arrêter* / *Réactiver* pour clore ou reprendre un contrat.

---

## 8. Les apporteurs et commissions

Menu → **Apporteurs**. Détail complet dans [APPORTEURS.md](APPORTEURS.md). En résumé :
- Enregistrez la personne qui vous apporte un client (occasionnel / régulier ; un apporteur **régulier exige un SIRET**).
- Une commission suit le barème **8 / 9 / 10 %** sur le **montant HT encaissé**, et se verse **après** le règlement du client : *À encaisser* → *À verser* → *Versée*.
- Au versement, l'application propose d'enregistrer la **dépense** correspondante (catégorie « Commissions d'apport »).
- Alerte **DAS2** au-delà de 2 400 € versés à une même personne dans l'année.
- Rappel affiché : en micro-entreprise, la commission **ne se déduit pas** de votre chiffre d'affaires à déclarer.

---

## 9. Les dépenses

Menu → **Dépenses** → *Ajouter une dépense*. Fournisseur, date, échéance, **montant HT**, **TVA %**, catégorie, moyen de paiement, « déjà payée », commentaire, et **pièce jointe** (PDF/JPG/PNG). Le TTC est calculé automatiquement. Ces montants nourrissent le solde de trésorerie et la répartition des dépenses dans Finances.

---

## 10. Les documents et justificatifs

Menu → **Documents**, ou depuis chaque fiche (client, devis, projet, facture, dépense, apporteur). Formats acceptés : **PDF, JPEG, PNG, 10 Mo maximum**. Stockage privé, téléchargement authentifié. C'est ici que vous rangez conventions d'apport, preuves de virement, contrats et justificatifs.

---

## 11. Le calendrier et les alertes

- **Calendrier** — échéances de devis, projets, factures, dépenses et abonnements, en vues Jour / Mois / Année / **Archives** (factures et dépenses classées par mois, filtrables par statut de paiement).
- **Notifications** (cloche, en haut) — échéances tombant sous 7 jours, avec état « lu » persistant.
- **Recherche globale** — ⌘K, sur clients, projets, devis, factures et documents.

---

## 12. Le tableau de bord et les finances

- **Vue d'ensemble** — CA facturé du mois, reste à encaisser, projets en cours, revenu récurrent, échéances à suivre, dernières actions.
- **Finances** — encaissements vs dépenses sur une période (7 j / 30 j / 3 mois / année / personnalisé), répartition par prestation et par catégorie, MRR/ARR, journal des encaissements.
- **Export CSV** disponible sur la plupart des listes (clients, devis, factures, dépenses, commissions, finances) pour votre comptable.

> Le solde présenté compare encaissements et dépenses payées. Il **ne déduit pas** vos cotisations, impôts ou amortissements.

---

## 13. Rythme de tenue conseillé

- **À chaque affaire** : devis → preuve d'acceptation (PDF signé) → projet → facture → encaissement enregistré le jour du virement.
- **Chaque semaine** : pointer les paiements reçus, marquer les commissions « à verser » une fois le client réglé, classer les justificatifs.
- **Chaque mois** : rapprocher le journal des encaissements avec la banque, saisir les dépenses, vérifier les échéances d'abonnements.
- **Chaque année** : vérifier les apporteurs dépassant 2 400 € (DAS2, dépôt début mai), surveiller votre CA vis-à-vis des **seuils de franchise TVA** (37 500 € / 41 250 € en 2026), archiver l'exercice.

**Conservation** : gardez devis, factures émises, preuves de paiement et justificatifs de commission. Une facture émise ne se supprime jamais.

---

## 14. Ce que l'application ne fait pas (limites à connaître)

Ces points relèvent de votre comptable ou d'une évolution future — le logiciel ne les couvre pas aujourd'hui :

- **Avoirs / factures rectificatives** : non gérés. On annule (statut *Annulée*) et on réémet.
- **Facturation électronique réglementaire** (Factur-X / plateforme agréée, obligation d'émission au 1er sept. 2027) : l'application produit un **PDF**, qui ne suffit pas à lui seul au format e-invoicing.
- **Suivi automatique des seuils de TVA** (37 500 / 41 250 €) et **bascule de régime** : à surveiller vous-même ; la TVA se saisit manuellement par ligne.
- **International** : pas de champ « pays du client » ni « n° de TVA intracommunautaire », ni mention « autoliquidation » automatique. À gérer dans les mentions et avec le SIE.
- **Récapitulatif TVA par taux** sur le PDF : la TVA est présentée en un total (adapté à la franchise ; à vérifier avec votre comptable dès que vous facturez plusieurs taux).
- **Calcul des cotisations, de l'impôt et des déclarations** : hors périmètre. L'application aide au suivi et à la conservation des pièces, elle ne produit aucune déclaration.

---

*Ce guide décrit le fonctionnement de l'outil au 17/09/2026. Les règles fiscales dépendent de votre statut exact, du type de client et de la prestation : confirmez les cas particuliers avec le SIE ou un expert-comptable.*
