# Apporteurs d’affaires et commissions — 12 septembre 2026

## Principe retenu
Une personne met le studio en relation avec un prospect. Le studio établit le devis, vend et réalise : l’apporteur n’est pas un agent commercial, il ouvre une porte. Sa commission porte sur chaque devis signé **et effectivement encaissé**, calculée sur le montant HT réellement reçu. Si le client annule, ne paie pas ou obtient une réduction, aucune commission n’est due sur l’argent jamais perçu.

Le parcours complet : mise en relation → devis → signature → encaissement client → commission exigible → virement à l’apporteur → conservation des justificatifs.

## Barème
Tranches exclusives, sans chevauchement, appliquées à l’assiette HT encaissée :

| Assiette HT encaissée | Taux |
| --- | --- |
| jusqu’à 999,99 € | 8 % |
| de 1 000 € à 2 000 € inclus | 9 % |
| au-delà de 2 000 € | 10 % |

Le barème vit dans `COMMISSION_TIERS` (`shared/money.js`) : une seule modification y suffit, l’interface et le calcul serveur en découlent. Le taux proposé par le formulaire est celui du barème ; il reste modifiable ligne par ligne pour une négociation particulière. Les montants sont des entiers en centimes et les taux des points de base, arrondis au demi-centime supérieur comme le reste de l’application.

## Statuts d’une commission
- **À encaisser** (`awaiting`) : le client n’a pas encore payé, rien n’est dû.
- **À verser** (`due`) : le client a réglé, la commission est exigible.
- **Versée** (`settled`) : le virement est parti, avec sa date et sa référence.
- **Annulée** (`cancelled`) : l’affaire ne s’est pas faite.

Le passage à « à verser » est une décision explicite de l’utilisateur, jamais une dérivation automatique d’un paiement : c’est lui qui constate l’encaissement. Le versement est refusé tant que la commission n’est pas exigible. Une commission versée est figée : ni modification ni suppression, pour qu’elle reste un justificatif fiable. En cas d’erreur, « annuler le versement » la ramène à « à verser » et retire la dépense créée avec elle, sauf si un justificatif y est déjà rattaché.

## Trésorerie
À chaque versement, l’application propose d’enregistrer la dépense correspondante (catégorie « Commissions d’apport », fournisseur = apporteur, commentaire portant le client et la référence du virement). Le solde de trésorerie des Finances reste ainsi juste. La case est décochable si la dépense est saisie autrement ; le lien entre commission et dépense est conservé pour éviter tout double comptage.

## Ce que le studio déclare
En micro-entreprise, le chiffre d’affaires à déclarer est le **montant total encaissé**, commission comprise : les charges ne sont pas déductibles du CA servant au calcul des cotisations. Un site facturé 3 000 € et encaissé en totalité se déclare 3 000 €, puis 300 € partent chez l’apporteur.

## Occasionnel ou régulier
Un apport occasionnel reste un revenu que l’apporteur déclare lui-même. En revanche, une activité habituelle — prospection, apports répétés, commissions régulières — suppose un statut professionnel : l’apporteur facture alors ses commissions. L’application matérialise cette distinction sur la fiche apporteur et refuse d’enregistrer un apporteur « régulier » sans SIRET.

## Seuil DAS2
Les sommes versées à un même bénéficiaire sont totalisées par année civile. Au-delà de 2 400 € versés dans l’année à une même personne, l’application signale la déclaration DAS2 à déposer, par voie électronique, au début du mois de mai de l’année suivante pour qui n’est pas tenu à une déclaration de résultat. En dessous du seuil, il n’y a pas de DAS2 à déposer pour cette personne : cela ne signifie pas que la somme échappe à l’impôt, l’apporteur reste tenu de déclarer son revenu. Le seuil est la constante `DAS2_THRESHOLD_CENTS` (`shared/money.js`).

## Justificatifs à conserver
Pour chaque apport : convention d’apport d’affaires signée, nom de l’apporteur et du client, devis, montant encaissé, calcul de la commission et preuve du virement. La fiche apporteur accepte des pièces jointes (PDF, JPEG, PNG) pour y ranger la convention et les preuves de virement. Le virement bancaire est préférable aux espèces, avec un libellé explicite du type « Commission apport affaire - Client Dupont ». L’export CSV reprend, par ligne, les deux dates, l’assiette, le taux, le montant et la référence.

## Mise en œuvre technique
- Modèles `Referrer` et `Commission`, champ `Client.referrerId` (qui a apporté ce client) et `Document.referrerId` (justificatifs). Migration `202609120001_referrals`.
- Contrats Zod : `referrerSchema`, `commissionSchema`, `settlementSchema` (`shared/contracts.js`), partagés client et serveur.
- Routes `server/routes/referrals.js` : `GET/POST/PATCH /api/referrers`, `GET/POST/PATCH/DELETE /api/commissions`, `PATCH /api/commissions/:id/status`, `POST /api/commissions/:id/settle`. Toutes les mutations sont transactionnelles et tracées dans le journal d’activité.
- Écran `/apporteurs` (`src/views/Referrals.vue`), onglet 11 de la barre latérale ; formulaires dans `CrudForm.vue`.
- Couverture : barème et arrondis dans `tests/money.test.js`, parcours complet dans `tests/integration/workflows.test.js`.

## Réserve
Ces règles traduisent le fonctionnement choisi pour le studio ; elles ne constituent pas un conseil fiscal ou comptable et les seuils doivent être confirmés auprès d’un professionnel avant tout usage déclaratif. L’application aide au suivi et à la conservation des pièces, elle ne produit aucune déclaration.
