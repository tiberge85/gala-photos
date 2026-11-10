# Gala Photos — retrouvez vos photos avec un selfie

Application web pour le Gala de la Jeunesse (EBPA), sur le principe de Memento :

- le **photographe** est le seul à déposer les photos de l'événement ;
- chaque **invité** scanne un QR code et fait un selfie, puis voit et télécharge les photos où il apparaît.

Aucune application à installer, aucun service de reconnaissance payant.

## Les pages

| Adresse | Pour qui | Rôle |
|---|---|---|
| `/` | Invités (QR code) | Selfie, puis « mes photos » et téléchargement (une par une ou en ZIP) |
| `/photographe` | Photographe (mot de passe) | Envoi en masse : chaque photo est analysée puis publiée |
| `/admin` | Organisateur (mot de passe) | Statistiques, suppression des photos ratées |
| `/galerie` | Tous ou admin seulement (`PUBLIC_GALLERY`) | Toutes les photos de la soirée |
| `/ecran` | Vidéoprojecteur | Diaporama en direct, avec le QR code affiché |
| `/qr` | Organisateur | Affiche A4 et cartes de table à imprimer |

## Comment marche la reconnaissance

1. **Chez le photographe** : son navigateur (Chrome sur ordinateur) repère tous les visages de chaque photo avec la bibliothèque open source `@vladmandic/face-api`. Il calcule pour chaque visage une *empreinte* de 128 nombres. Les photos de groupe sont aussi analysées en 4 morceaux pour ne pas rater les petits visages.
2. **Chez l'invité** : son téléphone calcule l'empreinte de son selfie. **Le selfie n'est jamais envoyé** : seule l'empreinte part au serveur, et elle reste gardée sur le téléphone pour relancer la recherche plus tard.
3. **Le serveur** compare l'empreinte à tous les visages et renvoie les photos proches (seuil `FACE_MATCH_THRESHOLD`).
4. **« Est-ce vous ? »** : les visages un peu au-delà du seuil sont proposés à l'invité. Chaque « Oui » ajoute ce visage comme référence supplémentaire, ce qui fait remonter les autres photos de la même soirée. Lors de nos tests, 2 réponses en moyenne faisaient passer de 23 à 57 photos retrouvées sur 66, sans fausse photo supplémentaire.

Les modèles (environ 7 Mo pour un invité, 12 Mo pour le photographe) sont servis par ton propre serveur et gardés en cache par le téléphone.

## Tester sur ton PC

```bash
npm install
cp .env.example .env     # laisse CLOUDINARY_URL vide pour le mode local
npm start                # http://localhost:3000
```

Pour tester depuis un téléphone sur le même Wi-Fi, ouvre `http://IP-DU-PC:3000`.

## Mise en ligne (Render + Cloudinary)

1. **Cloudinary** : crée un compte gratuit et copie la valeur « API environment variable » (`cloudinary://...`).
2. **GitHub** : pousse ce dossier dans un nouveau dépôt.
3. **Render** : New → Blueprint, choisis le dépôt, puis renseigne `CLOUDINARY_URL`, `ADMIN_PASSWORD`, `PHOTOGRAPHER_PASSWORD` et `PUBLIC_URL`.
4. **Domaine** : Render → Settings → Custom Domain, ajoute `gala.ramyaci.tech`, puis crée le CNAME chez ton registrar.
5. Ouvre `/qr` et imprime **après** avoir défini `PUBLIC_URL`.

Prends l'offre **Starter** de Render : l'offre gratuite se met en veille et le premier scan attendrait.

## Le soir du gala

- **Avant** : fais une répétition avec 10 à 20 personnes. Envoie leurs photos depuis `/photographe`, laisse-les faire leur selfie, puis regarde le taux « ont trouvé des photos » dans `/admin`. Si trop de photos manquent, monte `FACE_MATCH_THRESHOLD` à 0,52 ; si des inconnus apparaissent, descends-le à 0,48.
- **Photographe** : Chrome sur un ordinateur portable, page ouverte pendant l'envoi. Compte 1 à 3 secondes d'analyse par photo, avec envois en parallèle. Il peut déverser sa carte mémoire au fil de la soirée.
- **Invités** : les photos arrivent au fil de l'eau, et la page relance la recherche toute seule (chaque minute, et à chaque retour sur la page).
- **Après l'événement** : récupère le dossier `gala/gala-ebpa` depuis la Media Library de Cloudinary. Pour respecter la vie privée, supprime ensuite les empreintes (dossier `faces`) quand le service n'est plus utile.

## Limites connues

- Un selfie de profil, flou ou dans le noir donne de moins bons résultats : la page donne des conseils et propose de refaire le selfie.
- Si `PUBLIC_GALLERY=true`, n'importe qui peut voir toutes les photos sur `/galerie`. Mets `false` pour que chacun ne voie que les siennes.
- Comme pour Memento, quelqu'un pourrait utiliser la photo d'une autre personne au lieu de son propre selfie. Les photos d'un gala restant peu sensibles, c'est un risque acceptable.
- Pas de vidéos, photos uniquement.
