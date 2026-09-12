import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `PIN_PEPPER=${randomBytes(32).toString('hex')}\n`);
  console.log('Created the local PIN pepper in .dev.vars. Keep this file private.');
} else console.log('Existing .dev.vars preserved.');
