import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `ADMIN_SECRET=${randomBytes(32).toString('hex')}\nPIN_PEPPER=${randomBytes(32).toString('hex')}\n`);
  console.log('Created local secrets in .dev.vars. Keep this file private.');
} else console.log('Existing .dev.vars preserved.');
