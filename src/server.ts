import { config } from './config.js';
import { buildApp } from './app.js';
import { migrate } from './lib/migrate.js';
import { pool } from './lib/db.js';
import { startLive } from './lib/live.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { activeTenantIds, generateSlots } from './domain/slots.js';
import { ensureAdmin } from './lib/auth.js';

/**
 * Un solo processo fa API + worker. In produzione si possono separare:
 * WORKER=0 sulle istanze web, WORKER=1 su un'istanza dedicata ai job.
 */
/** Al primo avvio su Render il database può essere ancora in preparazione: aspetta fino a 5 minuti. */
async function waitForDatabase() {
  for (let i = 1; ; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (err) {
      if (i >= 60) throw err;
      console.log(`[avvio] Database non ancora raggiungibile, nuovo tentativo tra 5 secondi (${i}/60)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  await waitForDatabase();
  await migrate();
  await ensureAdmin((m) => console.log(`[avvio] ${m}`));
  for (const t of await activeTenantIds(pool)) await generateSlots(pool, t);
  await startQueue({ work: process.env.WORKER !== '0' });
  const stopLive = await startLive();

  const app = buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  const shutdown = async () => {
    app.log.info('Arresto in corso');
    await app.close();
    stopLive();
    await stopQueue();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
