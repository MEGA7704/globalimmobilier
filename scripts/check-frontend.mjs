import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!matches.length) throw new Error('Aucun script trouvé dans index.html');
for (const [i, match] of matches.entries()) {
  new vm.Script(match[1], { filename: `index-inline-${i + 1}.js` });
}
if (/Sauvegarde locale active/.test(html)) throw new Error('Texte localStorage restant détecté');
console.log(`Frontend valide: ${matches.length} script(s) analysé(s).`);
