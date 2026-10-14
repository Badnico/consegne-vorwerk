import { readFileSync } from 'node:fs';
import { pool } from './db.js';
import { readBackup, restoreBackup } from '../domain/backup.js';

/**
 * Ripristino di un backup scaricato dall'admin:
 *   npm run ripristina -- backup-consegne-AAAAMMGG-HHMM.json.gz
 * Attenzione: sostituisce TUTTI i dati del database indicato in DATABASE_URL.
 */
const path = process.argv[2];
if (!path) {
  console.error('Indica il file: npm run ripristina -- backup-consegne-....json.gz');
  process.exit(1);
}
const data = readBackup(readFileSync(path));
const client = await pool.connect();
try {
  const counts = await restoreBackup(client, data);
  console.log(`Backup del ${data.createdAt} ripristinato:`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
} finally {
  client.release();
  await pool.end();
}
