// Grants administrator access directly in D1. This is the bootstrap and recovery path for a
// deployment with no administrator left; day to day, administrators manage roles in /admin.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const username = args.find(a => !a.startsWith('--'));
if (!username || !/^[A-Za-z0-9_]{3,24}$/.test(username)) {
  console.error('Usage: npm run admin:grant -- <username> [--remote]');
  process.exit(1);
}
const wrangler = fileURLToPath(new URL('bin/wrangler.js', pathToFileURL(createRequire(import.meta.url).resolve('wrangler/package.json'))));
const where = remote ? 'remote' : 'local';
// The username pattern above admits only letters, digits, and underscores. The trailing SELECT
// confirms the grant, because the local D1 emulator does not report changed row counts.
const match = `username='${username}' COLLATE NOCASE`;
const command = `UPDATE users SET is_admin=1 WHERE ${match}; SELECT count(*) granted FROM users WHERE ${match} AND is_admin=1`;
const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'parlibench', `--${where}`, '--command', command, '--json'], { encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(result.status ?? 1); }
const output = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
if (!output.at(-1)?.results?.[0]?.granted) { console.error(`No account named ${username} on the ${where} database. Create the account first, then grant it.`); process.exit(1); }
console.log(`${username} is now an administrator on the ${where} database.`);
