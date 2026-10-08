import { pool, tx } from './db.js';
import { migrate } from './migrate.js';
import { generateSlots, replaceTemplates } from '../domain/slots.js';

/** Fasce di esempio: lunedì-sabato, quattro fasce con capienze diverse. */
const bands = [
  { start_time: '08:00', end_time: '11:00', capacity: 6 },
  { start_time: '11:00', end_time: '14:00', capacity: 5 },
  { start_time: '14:00', end_time: '17:00', capacity: 6 },
  { start_time: '17:00', end_time: '20:00', capacity: 4 },
];

await migrate();
const r = await tx(async (c) => {
  await replaceTemplates(c, [1, 2, 3, 4, 5, 6].flatMap((weekday) => bands.map((b) => ({ weekday, ...b }))));
  return generateSlots(c);
});
console.log(`Fasce di esempio salvate, ${r.generated} slot generati`);
await pool.end();
