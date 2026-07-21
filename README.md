# GLOBAL IMMOBILIER CLOUD

Version Cloudflare Pages + Functions de l’application **GLOBAL IMMOBILIER Multi-entreprises**.

## Architecture

- **Frontend** : `public/index.html`
- **API Cloudflare Pages Functions** : `functions/api/[[path]].js`
- **Base durable** : D1, binding `D1IM`
- **Sessions sécurisées** : KV, binding `KVIM`
- **Authentification** : cookie `HttpOnly`, mots de passe hachés avec PBKDF2-SHA-256
- **Synchronisation** : sauvegarde automatique dans D1 avec contrôle de version
- **Données volumineuses** : état de chaque entreprise découpé en plusieurs lignes D1
- **Anciennes données** : outil Super Admin « Importer localStorage »

Les tables sont préfixées par `gi_` pour ne pas entrer en conflit avec d’anciennes tables éventuellement présentes dans la même base D1.

## Ressources déjà configurées

Le fichier `wrangler.jsonc` contient :

- D1 `D1im` : `ef0b5766-b3cb-4c29-838a-aa654e5bdffb`
- KV `KVIM` : `67161ac889e0454ba2ee2de05c097aef`
- Identifiant Super Admin initial : `megaglobal0777`
- Nom du projet Pages : `global-immobilier-cloud`

Le mot de passe Super Admin est fourni dans les fichiers locaux `.dev.vars` et `.secrets.production.env`. Ces deux fichiers sont exclus de Git par `.gitignore` et ne doivent jamais être publiés dans le dépôt.

## Déploiement direct le plus simple

Dans le dossier du projet :

```bash
npm install
npx wrangler login
npm run deploy:complete
```

Le script :

1. crée le projet Pages s’il n’existe pas ;
2. applique la migration D1 ;
3. enregistre le secret `SUPER_ADMIN_PASSWORD` ;
4. publie le site et les Functions.

Contrôle après publication :

```text
https://VOTRE-PROJET.pages.dev/api/health
```

La réponse attendue contient `"status":"ok"`, `"database":"D1IM"`, `"kv":"KVIM"` et `"secretConfigured":true`.

## Publication avec GitHub et Cloudflare Pages

### 1. Envoyer le projet sur GitHub

```bash
git init
git add .
git commit -m "GLOBAL IMMOBILIER Cloudflare D1 KV"
git branch -M main
git remote add origin URL_DE_VOTRE_DEPOT_GITHUB
git push -u origin main
```

Les fichiers secrets ne seront pas ajoutés grâce au `.gitignore`.

### 2. Connecter le dépôt à Cloudflare

Dans **Workers & Pages** :

- créer une application Pages depuis Git ;
- sélectionner le dépôt GitHub ;
- branche de production : `main` ;
- commande de build : `npm run check` ;
- dossier de sortie : `public` ;
- répertoire racine : laisser vide.

Le fichier `wrangler.jsonc` fournit les bindings D1/KV au projet.

### 3. Ajouter le secret dans Cloudflare

Dans les paramètres du projet Pages, ajouter le secret chiffré :

```text
SUPER_ADMIN_PASSWORD
```

Ajouter le secret pour **Production** et, si nécessaire, pour **Preview**. Ne pas créer une variable texte ordinaire portant ce mot de passe.

### 4. Initialiser D1 une seule fois

Depuis un ordinateur connecté à Cloudflare :

```bash
npm install
npx wrangler login
npm run db:migrate:remote
```

La migration utilisée est `migrations/0001_gi_cloud_init.sql`.

## Développement local

```bash
npm install
npm run db:migrate:local
npm run dev
```

Ouvrir ensuite :

```text
http://localhost:8788
```

## Migration des anciennes données localStorage

La migration automatique doit être lancée dans le navigateur qui contient encore les anciennes données, sur la même origine où elles ont été enregistrées :

1. se connecter comme Super Admin ;
2. ouvrir **Entreprises et abonnements** ;
3. cliquer sur **Importer localStorage** ;
4. confirmer l’importation.

Le navigateur interdit à un nouveau domaine de lire le localStorage d’un ancien domaine. Dans ce cas, ouvrez d’abord l’ancienne application sur son domaine d’origine, exportez une sauvegarde JSON, puis importez les données depuis l’application cloud.

## Commandes utiles

```bash
npm run check
npm run db:migrate:local
npm run db:migrate:remote
npm run secret:upload
npm run deploy
npm run deploy:complete
```

## Sécurité et fonctionnement

- aucun mot de passe n’est enregistré dans l’état métier D1 ;
- les comptes sont conservés séparément avec hachage et sel ;
- les sessions sont stockées dans KV avec expiration ;
- les requêtes de modification vérifient l’origine ;
- les abonnements expirés ou suspendus bloquent la connexion ;
- la limite actuelle est de deux utilisateurs secondaires par entreprise ;
- les données d’une entreprise sont isolées par son identifiant.

## Vérifications effectuées

- syntaxe de l’API et du JavaScript frontend ;
- migration D1 locale ;
- contrôle des bindings D1/KV et du secret ;
- connexion Super Admin ;
- création d’entreprise ;
- sauvegarde et relecture D1 ;
- création, modification et connexion d’un utilisateur ;
- catalogue public ;
- demandes de visite ;
- vues et favoris publics ;
- exécution du frontend sans erreur JavaScript détectée.
