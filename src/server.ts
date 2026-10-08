import { config } from './config.js';
import { buildApp } from './app.js';
import { migrate } from './lib/migrate.js';
import { pool } from './lib/db.js';
import { startLive } from './lib/live.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { ensureDefaultTemplates, generateSlots } from './domain/slots.js';
import { ensureAdmin } from './lib/auth.js';

/**
 * Un solo processo fa API + worker. In produzione si possono separare:
 * WORKER=0 sulle istanze web, WORKER=1 su un'istanza dedicata ai job.
 */
async function main() {
  await migrate();
  await ensureAdmin((m) => console.log(`[avvio] ${m}`));
  if (await ensureDefaultTemplates(pool)) console.log('[avvio] Fasce standard create: modificale da "Slot e capienza"');
  await generateSlots(pool);
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
