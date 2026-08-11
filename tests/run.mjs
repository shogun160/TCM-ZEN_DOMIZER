// Führt alle Ziehlogik-Tests aus: node tests/run.mjs
// Braucht keine Dependencies - reines Node.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);
  const res = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} Testdateien bestanden`);
process.exit(failed ? 1 : 0);
