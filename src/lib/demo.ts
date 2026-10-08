import { pool } from './db.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';
import { addDays, todayLocal } from './dates.js';
import { availability, bookingWindow, generateSlots } from '../domain/slots.js';
import { createDelivery } from '../domain/deliveries.js';
import { createToken, customerUrl } from '../domain/tokens.js';
import { createTenant, getTenantBySlug } from '../domain/tenants.js';
import { formatDateIt, hhmm } from './dates.js';

/**
 * Crea una consegna di prova nell'ambiente indicato (default "demo") e stampa il link del cliente.
 * Serve per provare il flusso senza WhatsApp né email configurati.
 * Uso: npm run demo -- [nome cliente] [ambiente]
 */
await migrate();
await ensureAdmin((m) => console.log(m));
const slug = process.argv[3] ?? 'demo';
let tenant = await getTenantBySlug(pool, slug);
if (!tenant && slug === 'demo') {
  await createTenant({ name: 'Demo', slug: 'demo', username: 'demo', password: 'consegne-locale', email: 'demo@example.it', subscription_end: addDays(todayLocal(), 365) });
  tenant = await getTenantBySlug(pool, slug);
}
if (!tenant) { console.log(`Ambiente "${slug}" non trovato.`); process.exit(1); }
await generateSlots(pool, tenant.id);

const { from, to } = await bookingWindow(pool, tenant.id);
const slot = (await availability(pool, tenant.id, from, to)).find((s) => s.free > 0);
if (!slot) {
  console.log('Nessuno slot libero nei prossimi giorni: controlla le fasce.');
  process.exit(1);
}

const name = process.argv[2] ?? 'Marco Bellini';
const id = await createDelivery(
  tenant.id,
  {
    order_ref: `DEMO-${Date.now().toString().slice(-6)}`,
    customer: { name, email: 'cliente.demo@example.it' },
    address: 'Corso Lodi 45, Milano',
    product: 'Thermomix TM7',
    slot_id: slot.id,
  },
  'operator:demo',
);
const url = customerUrl(await createToken(pool, id, slot.date));

console.log(`\nConsegna di prova creata per ${name}`);
console.log(`Proposta: ${formatDateIt(slot.date)}, ${hhmm(slot.start_time)}–${hhmm(slot.end_time)}`);
console.log(`\nApri il link del cliente nel browser:\n${url}\n`);
await pool.end();
