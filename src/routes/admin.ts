import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator, actorOf } from '../lib/auth.js';
import { pool, tx } from '../lib/db.js';
import { DomainError } from '../lib/errors.js';
import { createDelivery, getDelivery, listDeliveries, confirmDelivery, declineDelivery, bookSlot } from '../domain/deliveries.js';
import { generateSlots, replaceTemplates } from '../domain/slots.js';
import { enqueue } from '../jobs/queue.js';
import { createToken, customerUrl } from '../domain/tokens.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^\d{2}:\d{2}$/);
const status = z.enum(['proposed', 'confirmed', 'to_reschedule', 'rescheduled', 'no_response', 'cancelled', 'delivered']);

const newDelivery = z
  .object({
    order_ref: z.string().min(1).max(64),
    customer: z.object({
      name: z.string().min(1).max(200),
      phone_e164: z.string().regex(/^\+\d{8,15}$/, 'Numero in formato internazionale, es. +393471234567').nullish(),
      email: z.string().email().nullish(),
      consent_whatsapp: z.boolean().default(false),
    }),
    address: z.string().min(3).max(300),
    cap: z.string().regex(/^\d{5}$/, 'Il CAP ha 5 cifre').nullish(),
    product: z.string().max(120).nullish(),
    slot_id: z.string().uuid().optional(),
    date: isoDate.optional(),
    start_time: time.optional(),
  })
  .refine((v) => v.customer.phone_e164 || v.customer.email, { message: 'Serve almeno telefono o email' })
  .refine((v) => v.slot_id || (v.date && v.start_time), { message: 'Indica slot_id oppure date + start_time' });

const templates = z.array(
  z.object({ weekday: z.number().int().min(0).max(6), start_time: time, end_time: time, capacity: z.number().int().min(0).max(999), active: z.boolean().optional() })
    .refine((t) => t.end_time > t.start_time, { message: "L'orario di fine deve essere dopo l'inizio" }),
);

async function resolveSlotId(input: z.infer<typeof newDelivery>) {
  if (input.slot_id) return input.slot_id;
  const r = await pool.query<{ id: string }>('SELECT id FROM slots WHERE date = $1 AND start_time = $2', [input.date, input.start_time]);
  if (!r.rows[0]) throw new DomainError('slot_not_found', `Nessuna fascia il ${input.date} alle ${input.start_time}.`, 422);
  return r.rows[0].id;
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireOperator);

  app.post('/deliveries', async (req, reply) => {
    const input = newDelivery.parse(req.body);
    const id = await createDelivery({ ...input, slot_id: await resolveSlotId(input) }, actorOf(req));
    await enqueue.proposal(id);
    return reply.code(201).send(await getDelivery(pool, id));
  });

  /** CSV con intestazione: order_ref,name,phone_e164,email,consent_whatsapp,address,cap,product,date,start_time */
  app.post('/deliveries/import', async (req) => {
    const text = String(req.body ?? '');
    const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
    const cols = (head ?? '').split(',').map((c) => c.trim());
    const results: { line: number; order_ref?: string; ok: boolean; error?: string }[] = [];
    for (const [i, line] of lines.entries()) {
      const cells = line.split(',').map((c) => c.trim()); // CSV semplice: per campi con virgole usare una libreria CSV
      const row = Object.fromEntries(cols.map((c, j) => [c, cells[j] ?? '']));
      try {
        const input = newDelivery.parse({
          order_ref: row.order_ref,
          customer: { name: row.name, phone_e164: row.phone_e164 || null, email: row.email || null, consent_whatsapp: row.consent_whatsapp === 'true' },
          address: row.address,
          cap: row.cap || null,
          product: row.product || null,
          date: row.date,
          start_time: row.start_time,
        });
        const id = await createDelivery({ ...input, slot_id: await resolveSlotId(input) }, actorOf(req) + ':import');
        await enqueue.proposal(id);
        results.push({ line: i + 2, order_ref: row.order_ref, ok: true });
      } catch (err) {
        results.push({ line: i + 2, order_ref: row.order_ref, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { imported: results.filter((r) => r.ok).length, results };
  });

  app.get('/deliveries', async (req) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), status: status.optional() }).parse(req.query);
    return listDeliveries(pool, q);
  });

  app.get('/deliveries/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await getDelivery(pool, id);
    const events = (await pool.query('SELECT from_status, to_status, actor, note, created_at FROM delivery_events WHERE delivery_id = $1 ORDER BY id', [id])).rows;
    const messages = (await pool.query('SELECT channel, direction, kind, status, created_at FROM messages WHERE delivery_id = $1 ORDER BY created_at', [id])).rows;
    return { ...d, events, messages };
  });

  app.post('/deliveries/:id/resend', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await getDelivery(pool, id);
    if (d.status === 'proposed') await enqueue.proposal(id);
    else if (d.status === 'to_reschedule') await enqueue.afterDecline(id);
    else throw new DomainError('nothing_to_resend', 'Per questo stato non c\'è un messaggio da reinviare.');
    return { queued: true };
  });

  /** Genera un nuovo link cliente, da inviare a mano (es. dopo una telefonata) o per i test */
  app.post('/deliveries/:id/link', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await getDelivery(pool, id);
    return { url: customerUrl(await createToken(pool, id, d.date ?? new Date().toISOString().slice(0, 10))) };
  });

  /** Azioni dell'operatore per conto del cliente (es. dopo una telefonata) */
  app.post('/deliveries/:id/confirm', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await confirmDelivery(id, actorOf(req));
    return getDelivery(pool, id);
  });
  app.post('/deliveries/:id/decline', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await declineDelivery(id, actorOf(req));
    return getDelivery(pool, id);
  });
  app.post('/deliveries/:id/book', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { slot_id } = z.object({ slot_id: z.string().uuid() }).parse(req.body);
    await bookSlot(id, slot_id, actorOf(req));
    return getDelivery(pool, id);
  });

  /** Calendario: slot con capienza, occupati e consegne attive */
  app.get('/calendar', async (req) => {
    const { from, to } = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    const slots = (
      await pool.query(
        `SELECT s.id, s.date, s.start_time, s.end_time, s.capacity, s.booked,
                COALESCE(json_agg(json_build_object('id', d.id, 'order_ref', d.order_ref, 'status', d.status, 'customer', c.name))
                         FILTER (WHERE d.id IS NOT NULL), '[]') AS deliveries
           FROM slots s
           LEFT JOIN deliveries d ON d.slot_id = s.id
           LEFT JOIN customers c ON c.id = d.customer_id
          WHERE s.date BETWEEN $1 AND $2
          GROUP BY s.id ORDER BY s.date, s.start_time`,
        [from, to],
      )
    ).rows;
    return { from, to, slots };
  });

  app.get('/slot-templates', async () =>
    (await pool.query('SELECT id, weekday, start_time, end_time, capacity, active FROM slot_templates WHERE active ORDER BY weekday, start_time')).rows,
  );

  app.put('/slot-templates', async (req) => {
    const items = templates.parse(req.body);
    return tx(async (c) => {
      await replaceTemplates(c, items);
      return generateSlots(c);
    });
  });

  app.put('/slot-overrides/:date', async (req) => {
    const { date } = z.object({ date: isoDate }).parse(req.params);
    const body = z.array(z.object({ template_id: z.string().uuid(), capacity: z.number().int().min(0).max(999) })).parse(req.body);
    return tx(async (c) => {
      await c.query('DELETE FROM slot_overrides WHERE date = $1', [date]);
      for (const o of body) await c.query('INSERT INTO slot_overrides (date, template_id, capacity) VALUES ($1, $2, $3)', [date, o.template_id, o.capacity]);
      return generateSlots(c);
    });
  });
}
