# GLOBAL IMMOBILIER — Cloudflare Pages, D1 et KV

Projet adapté au nom définitif suivant :

- **Projet Cloudflare Pages** : `globalimmobilier`
- **Adresse publique** : `https://globalimmobilier.pages.dev/`
- **Dépôt GitHub prévu** : `https://github.com/MEGA7704/globalimmobilier`
- **Branche de production** : `main`

## Ressources Cloudflare déjà configurées

Le fichier `wrangler.json` contient les liaisons suivantes :

- D1, binding `D1IM`, base `D1im`
- KV, binding `KVIM`
- Identifiant Super Admin : `megaglobal0777`
- Durée de session : `604800` secondes
- Taille maximale de l’état : `12582912` octets

Le mot de passe Super Admin n’est volontairement pas enregistré dans le dépôt. Il doit rester un secret Cloudflare nommé exactement :

```text
SUPER_ADMIN_PASSWORD
```

## Configuration GitHub + Cloudflare Pages

### Dépôt GitHub

Le dépôt recommandé est :

```text
https://github.com/MEGA7704/globalimmobilier
```

Placez directement à la racine du dépôt les dossiers et fichiers présents dans cette archive. Ne placez pas le dossier `globalimmobilier` dans un autre sous-dossier.

### Réglages du build Cloudflare

Dans Cloudflare Pages, configurez :

- Nom du projet : `globalimmobilier`
- Branche de production : `main`
- Framework : `Aucun`
- Commande de build : `exit 0`
- Répertoire de sortie : `public`
- Répertoire racine : laisser vide

Ce projet ne contient aucune dépendance npm. Le fichier `wrangler.json` désactive désormais explicitement l’installation automatique avec `SKIP_DEPENDENCY_INSTALL=1`. Une version de secours est également fixée avec Node.js `20.19.4` et npm `10.8.1`, afin d’éviter le bogue npm 10.9.2 « Exit handler never called! ».



### Correction de l’erreur npm du 23 juillet 2026

Le déploiement échouait avant l’exécution de la commande de build, pendant cette étape inutile :

```text
Installing project dependencies: npm clean-install --progress=false
npm error Exit handler never called!
```

La correction est intégrée au dépôt :

```text
SKIP_DEPENDENCY_INSTALL=1
NODE_VERSION=20.19.4
NPM_VERSION=10.8.1
```

Après avoir remplacé les fichiers du dépôt GitHub, ouvrez le projet Cloudflare Pages, effacez une fois le cache de build si cette option est proposée, puis relancez un déploiement de production. Le journal doit passer directement à la commande `exit 0`, sans lancer `npm clean-install`.

## Secret Super Admin

Dans le projet Cloudflare **globalimmobilier** :

1. ouvrez `Paramètres` ;
2. ouvrez `Variables et secrets` ;
3. choisissez l’environnement **Production** ;
4. ajoutez un **Secret** ;
5. nommez-le exactement `SUPER_ADMIN_PASSWORD` ;
6. saisissez votre mot de passe ;
7. enregistrez ;
8. lancez un nouveau déploiement de production.

Le secret doit être ajouté au projet `globalimmobilier`, pas à un ancien projet ayant un autre nom.

## Initialisation D1

La migration doit être appliquée une seule fois :

```bash
npx --yes wrangler@latest login
npx --yes wrangler@latest d1 migrations apply D1IM --remote
```

Le fichier SQL utilisé est :

```text
migrations/0001_gi_cloud_init.sql
```

## Déploiement automatique depuis un ordinateur

### Windows

Double-cliquez sur :

```text
DEPLOIEMENT_WINDOWS.bat
```

### Linux ou macOS

```bash
./DEPLOIEMENT_LINUX_MAC.sh
```

Le script vérifie si `SUPER_ADMIN_PASSWORD` existe. S’il manque, Wrangler vous demande sa valeur dans une invite sécurisée, puis publie sur :

```text
https://globalimmobilier.pages.dev/
```

## Vérification

Après le déploiement, ouvrez :

```text
https://globalimmobilier.pages.dev/api/health
```

La réponse doit indiquer que D1, KV et le secret sont configurés. Ensuite, connectez-vous avec :

```text
Identifiant : megaglobal0777
Mot de passe : valeur enregistrée dans SUPER_ADMIN_PASSWORD
```

## Organisation du projet

```text
public/
  index.html
  _headers
functions/
  api/
    [[path]].js
migrations/
  0001_gi_cloud_init.sql
scripts/
  check-frontend.mjs
  deploy-complete.mjs
wrangler.json
DEPLOIEMENT_WINDOWS.bat
DEPLOIEMENT_LINUX_MAC.sh
README.md
```

## Sécurité

Les fichiers contenant un vrai mot de passe ne sont pas inclus dans cette nouvelle archive. Ne publiez jamais `.dev.vars`, `.env` ou un fichier de secrets dans GitHub.
Déploiement Cloudflare relancé le 23 juillet 2026.
