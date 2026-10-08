import { pool } from './db.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';
import { addDays, todayLocal } from './dates.js';
import { createTenant, getTenantBySlug } from '../domain/tenants.js';

/** Solo in locale: crea il superamministratore e un ambiente di prova "demo" con fasce standard. */
await migrate();
await ensureAdmin((m) => console.log(m));
if (await getTenantBySlug(pool, 'demo')) {
  console.log('Ambiente "demo" già presente: http://localhost:3000/demo/ (utente demo / consegne-locale)');
} else {
  await createTenant({ name: 'Demo', slug: 'demo', username: 'demo', password: 'consegne-locale', email: 'demo@example.it', subscription_end: addDays(todayLocal(), 365) });
  console.log('Ambiente "demo" creato: http://localhost:3000/demo/ (utente demo / consegne-locale)');
}
await pool.end();
