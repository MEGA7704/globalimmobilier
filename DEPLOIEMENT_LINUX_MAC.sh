#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
printf '%s\n' 'GLOBAL IMMOBILIER - Déploiement Cloudflare' \
  'Projet : globalimmobilier' \
  'URL : https://globalimmobilier.pages.dev/'
npx --yes wrangler@latest login
node scripts/deploy-complete.mjs
