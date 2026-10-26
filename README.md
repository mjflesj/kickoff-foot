# KICKOFF — mini-jeu de football multijoueur

Petit jeu de foot 2D jouable dans un navigateur, avec déplacements en temps réel et salons privés. Stack : Node.js, Express, Socket.IO et Canvas.

## Fonctionnalités
- Créer une salle privée et partager un code ou un lien d'invitation.
- Jusqu'à 4 joueurs par salon, répartis en équipes bleue et rouge.
- Déplacements avec ZQSD/WASD ou flèches, tir avec Espace.
- Physique simple du ballon, collisions, buts et tableau de score.
- Interface française responsive, sans compte utilisateur.

## Lancer sur ton ordinateur
1. Installe Node.js 18 ou plus récent.
2. Ouvre un terminal dans ce dossier.
3. Lance `npm install` puis `npm start`.
4. Ouvre `http://localhost:3000`.

Pour tester le multijoueur local, ouvre le site dans deux fenêtres ou deux navigateurs. Pour jouer avec un ami à distance, il faut déployer le serveur sur Internet.

## Mise en ligne (Render)
1. Crée un dépôt GitHub et ajoute tous les fichiers de ce dossier.
2. Dans Render, crée un **Web Service** depuis ce dépôt.
3. Choisis `npm install` comme Build Command et `npm start` comme Start Command.
4. Node est détecté automatiquement. Le serveur écoute sur le port fourni par `PORT`.
5. Une fois le service déployé, ouvre l'URL Render et partage le code de salle avec tes amis.

Le fichier `render.yaml` configure aussi les commandes du service si tu choisis un déploiement Blueprint.

## Limites de cette première version
- Le jeu est un prototype arcade : pas encore de gardien, tournoi, matchmaking public, comptes, classement ou anti-triche avancé.
- Les instances gratuites de certains hébergeurs peuvent se mettre en veille et provoquer une courte reconnexion.
- Ne collecte aucune donnée personnelle ; les pseudos sont temporaires et les salons sont supprimés quand il n'y a plus de joueur.
