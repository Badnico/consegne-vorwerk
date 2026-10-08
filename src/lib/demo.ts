import { pool, tx } from './db.js';
import { migrate } from './migrate.js';
import { availability, bookingWindow, generateSlots, replaceTemplates } from '../domain/slots.js';
import { createDelivery } from '../domain/deliveries.js';
import { createToken, customerUrl } from '../domain/tokens.js';
import { formatDateIt, hhmm } from './dates.js';

/**
 * Crea una consegna di prova nel primo slot libero e stampa il link del cliente.
 * Serve per provare il flusso senza WhatsApp né email configurati.
 */
await migrate();
const hasTemplates = (await pool.query('SELECT 1 FROM slot_templates WHERE active LIMIT 1')).rowCount;
if (!hasTemplates) {
  const bands = [['08:00', '11:00', 6], ['11:00', '14:00', 5], ['14:00', '17:00', 6], ['17:00', '20:00', 4]] as const;
  await tx(async (c) => {
    await replaceTemplates(c, [1, 2, 3, 4, 5, 6].flatMap((weekday) => bands.map(([s, e, cap]) => ({ weekday, start_time: s, end_time: e, capacity: cap }))));
  });
}
await generateSlots(pool);

const { from, to } = await bookingWindow(pool);
const slot = (await availability(pool, from, to)).find((s) => s.free > 0);
if (!slot) {
  console.log('Nessuno slot libero nei prossimi giorni: controlla le fasce.');
  process.exit(1);
}

const name = process.argv[2] ?? 'Marco Bellini';
const id = await createDelivery(
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
