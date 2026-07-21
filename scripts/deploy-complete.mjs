import { spawnSync } from 'node:child_process';

const projectName = 'globalimmobilier';
const wrangler = ['--yes', 'wrangler@latest'];

function execute(args, options = {}) {
  const { allowAlreadyExists = false, interactive = false, capture = false } = options;
  const result = spawnSync('npx', [...wrangler, ...args], {
    encoding: capture || !interactive ? 'utf8' : undefined,
    shell: process.platform === 'win32',
    stdio: interactive ? 'inherit' : undefined,
  });

  const output = interactive ? '' : `${result.stdout || ''}${result.stderr || ''}`;
  if (output) process.stdout.write(output);
  if (result.status === 0) return output;
  if (allowAlreadyExists && /already exists|existe déjà|project.*exists/i.test(output)) return output;
  process.exit(result.status ?? 1);
}

execute([
  'pages', 'project', 'create', projectName,
  '--production-branch', 'main',
], { allowAlreadyExists: true });

execute(['d1', 'migrations', 'apply', 'D1IM', '--remote']);

const secrets = execute([
  'pages', 'secret', 'list',
  '--project-name', projectName,
], { capture: true });

if (!/SUPER_ADMIN_PASSWORD/.test(secrets)) {
  console.log('\nLe secret SUPER_ADMIN_PASSWORD est absent. Saisissez maintenant sa valeur dans l’invite sécurisée Cloudflare.\n');
  execute([
    'pages', 'secret', 'put', 'SUPER_ADMIN_PASSWORD',
    '--project-name', projectName,
  ], { interactive: true });
}

execute([
  'pages', 'deploy', 'public',
  '--project-name', projectName,
  '--branch', 'main',
]);

console.log('\nDéploiement terminé : https://globalimmobilier.pages.dev/');
