import { spawnSync } from 'node:child_process';

const projectName = 'global-immobilier-cloud';

function run(command, args, { allowAlreadyExists = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  if (result.status === 0) return;
  if (allowAlreadyExists && /already exists|existe déjà|project.*exists/i.test(output)) return;
  process.exit(result.status ?? 1);
}

run('npx', [
  'wrangler', 'pages', 'project', 'create', projectName,
  '--production-branch', 'main',
  '--compatibility-date', '2026-07-21',
], { allowAlreadyExists: true });
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'D1IM', '--remote']);
run('npx', ['wrangler', 'pages', 'secret', 'bulk', '.secrets.production.env', '--project-name', projectName]);
run('npx', ['wrangler', 'pages', 'deploy', 'public', '--project-name', projectName]);
