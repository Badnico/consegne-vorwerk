import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../lib/db.js';
import { addDays, hhmm, todayLocal } from '../lib/dates.js';
import { DomainError } from '../lib/errors.js';
import { actorOf, requireOperator, tenantOf } from '../lib/auth.js';
import {
  bookSlot, confirmDelivery, declineDelivery, createDelivery, deleteDelivery, deliveryEvents, getDelivery, listDeliveries,
  markDelivered, markFailedLetCustomerChoose, type DeliveryView, type Status,
} from '../domain/deliveries.js';
import { generateSlots, replaceTemplates } from '../domain/slots.js';
import {
  getArea, getBooking, getMessages, parseArea, saveArea, saveBooking, saveMessages, validateMessages, MESSAGE_DEFAULTS, type Messages,
} from '../domain/settings.js';
import { createToken, customerUrl } from '../domain/tokens.js';
import { enqueue } from '../jobs/queue.js';

/**
 * API del pannello operatori. I dati hanno la stessa forma usata dalla demo:
 * stati in italiano, fascia identificata da "HH:MM-HH:MM".
 */
const IT: Record<Status, string> = {
  proposed: 'inviato', confirmed: 'confermato', to_reschedule: 'da_riprogrammare', rescheduled: 'riprogrammato',
  out_of_area: 'fuori_area', no_response: 'senza_risposta', cancelled: 'annullata', delivered: 'consegnata',
};
const bandId = (start: string | null, end: string | null) => (start && end ? `${hhmm(start)}-${hhmm(end)}` : null);

function toPanel(d: DeliveryView, log: { t: string; ev: string }[] = []) {
  return {
    id: d.id,
    code: d.order_ref,
    name: d.customer_name,
    address: d.address,
    cap: d.cap ?? '',
    phone: d.phone_e164 ?? '',
    email: d.email ?? '',
    product: d.product ?? '',
    date: d.slot_id ? d.date : null,
    bandId: d.slot_id ? bandId(d.start_time, d.end_time) : null,
    status: IT[d.status],
    proposed: { date: d.proposed_date, bandId: bandId(d.proposed_start, d.proposed_end) },
    failed: d.failed_attempts,
    deliveredAt: d.delivered_at,
    log,
  };
}

/** Fasce come le mostra il pannello: le stesse per tutti i giorni attivi. */
async function getSchedule(tenantId: string) {
  const t = (await pool.query<{ weekday: number; start_time: string; end_time: string; capacity: number }>(
    'SELECT weekday, start_time, end_time, capacity FROM slot_templates WHERE tenant_id = $1 AND active ORDER BY start_time, weekday',
    [tenantId],
  )).rows;
  const bands = new Map<string, { id: string; start: string; end: string; cap: number }>();
  for (const r of t) {
    const id = bandId(r.start_time, r.end_time)!;
    const b = bands.get(id);
    if (!b) bands.set(id, { id, start: hhmm(r.start_time), end: hhmm(r.end_time), cap: r.capacity });
    else b.cap = Math.max(b.cap, r.capacity);
  }
  const booking = await getBooking(pool, tenantId);
  return { bands: [...bands.values()], days: [...new Set(t.map((r) => r.weekday))].sort(), horizon: booking.horizon, lead: booking.lead };
}

async function slotIdFor(tenantId: string, date: string, band: string) {
  const [start] = band.split('-');
  const r = await pool.query<{ id: string }>('SELECT id FROM slots WHERE tenant_id = $1 AND date = $2 AND start_time = $3', [tenantId, date, start]);
  if (!r.rows[0]) throw new DomainError('slot_not_found', `Nessuna fascia ${band} il ${date}. Controlla giorni e fasce in "Slot e capienza".`, 422);
  return r.rows[0].id;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^\d{2}:\d{2}$/);
const idParam = z.object({ id: z.string().uuid() });

export async function panelRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireOperator);

  app.get('/state', async (req) => {
    const t = tenantOf(req);
    const today = todayLocal();
    const list = await listDeliveries(pool, t, { openOrSince: addDays(today, -60) });
    const logs = await deliveryEvents(pool, list.map((d) => d.id));
    return {
      today,
      schedule: await getSchedule(t),
      area: await getArea(pool, t),
      messages: await getMessages(pool, t),
      deliveries: list.map((d) => toPanel(d, logs.get(d.id))),
    };
  });

  app.post('/deliveries', async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(1, 'Inserisci il nome del cliente').max(200),
      address: z.string().trim().min(3, "Inserisci l'indirizzo").max(300),
      cap: z.string().regex(/^\d{5}$/, 'Il CAP ha 5 cifre'),
      phone: z.string().trim().max(30).optional().default(''),
      email: z.string().trim().max(200).optional().default(''),
      product: z.string().trim().max(120).optional().default(''),
      date: isoDate,
      bandId: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/),
    }).parse(req.body);
    if (!b.phone && !b.email) throw new DomainError('missing_contact', 'Serve almeno un contatto: WhatsApp o email.', 422);
    if (b.email && !z.string().email().safeParse(b.email).success) throw new DomainError('invalid_email', 'Email non valida.', 422);
    const phone = b.phone ? b.phone.replace(/[^\d+]/g, '').replace(/^(?!\+)/, '+39') : null;
    const t = tenantOf(req);
    const id = await createDelivery(t, {
      order_ref: `VK-${Math.floor(10000 + Math.random() * 89999)}`,
      customer: { name: b.name, phone_e164: phone, email: b.email || null, consent_whatsapp: Boolean(phone) },
      address: b.address, cap: b.cap, product: b.product || null,
      slot_id: await slotIdFor(t, b.date, b.bandId),
    }, actorOf(req));
    await enqueue.proposal(id);
    return reply.code(201).send(toPanel(await getDelivery(pool, id)));
  });

  /** Slot per l'assegnazione da parte dell'operatore: da oggi fino alla fine della finestra di prenotazione */
  app.get('/availability', async (req) => {
    const { id } = z.object({ id: z.string().uuid().optional() }).parse(req.query);
    const t = tenantOf(req);
    const b = await getBooking(pool, t);
    const from = todayLocal(), to = addDays(from, b.lead + b.horizon - 1);
    const mine = id ? (await getDelivery(pool, id, t)).slot_id : null;
    const r = await pool.query<{ id: string; date: string; start_time: string; end_time: string; capacity: number; booked: number }>(
      'SELECT id, date, start_time, end_time, capacity, booked FROM slots WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 AND capacity > 0 ORDER BY date, start_time',
      [t, from, to],
    );
    return r.rows.map((s) => ({ id: s.id, date: s.date, bandId: bandId(s.start_time, s.end_time), free: Math.max(s.capacity - s.booked, 0), mine: s.id === mine }));
  });

  app.post('/deliveries/:id/book', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ slot_id: z.string().uuid(), failed: z.boolean().optional(), asCustomer: z.boolean().optional() }).parse(req.body);
    // asCustomer: scelta fatta dall'anteprima al posto del cliente, con le sue regole (area, giorni prenotabili)
    const actor = b.asCustomer ? `customer:pannello (${actorOf(req)})` : actorOf(req);
    await bookSlot(id, b.slot_id, actor, { failed: b.asCustomer ? false : b.failed, tenantId: tenantOf(req) });
    await enqueue.afterConfirm(id);
    return toPanel(await getDelivery(pool, id));
  });

  /** Sì / No dato dall'anteprima al posto del cliente: stessi effetti e messaggi della risposta vera. */
  app.post('/deliveries/:id/answer', async (req) => {
    const { id } = idParam.parse(req.params);
    const { answer } = z.object({ answer: z.enum(['yes', 'no']) }).parse(req.body);
    const t = tenantOf(req), actor = `customer:pannello (${actorOf(req)})`;
    if (answer === 'yes') { await confirmDelivery(id, actor, t); await enqueue.afterConfirm(id); }
    else { await declineDelivery(id, actor, t); await enqueue.afterDecline(id); }
    return toPanel(await getDelivery(pool, id));
  });

  app.post('/deliveries/:id/delivered', async (req) => {
    const { id } = idParam.parse(req.params);
    await markDelivered(id, actorOf(req), tenantOf(req));
    return toPanel(await getDelivery(pool, id));
  });

  /** Non consegnata: il cliente riceve il link per scegliere (o il messaggio "fuori area") */
  app.post('/deliveries/:id/failed', async (req) => {
    const { id } = idParam.parse(req.params);
    await markFailedLetCustomerChoose(id, actorOf(req), tenantOf(req));
    await enqueue.afterDecline(id);
    return toPanel(await getDelivery(pool, id));
  });

  app.delete('/deliveries/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await deleteDelivery(id, tenantOf(req));
    return reply.code(204).send();
  });

  app.post('/deliveries/delete-delivered', async (req) => {
    const t = tenantOf(req);
    const r = await pool.query<{ id: string }>(`SELECT id FROM deliveries WHERE tenant_id = $1 AND status = 'delivered'`, [t]);
    for (const { id } of r.rows) await deleteDelivery(id, t);
    return { deleted: r.rows.length };
  });

  app.post('/deliveries/:id/link', async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await getDelivery(pool, id, tenantOf(req));
    return { url: customerUrl(await createToken(pool, id, d.date ?? d.proposed_date)) };
  });

  app.put('/schedule', async (req) => {
    const b = z.object({
      bands: z.array(z.object({ start: time, end: time, cap: z.number().int().min(0).max(999) })
        .refine((x) => x.end > x.start, { message: "L'orario di fine deve essere dopo l'inizio" })).max(24),
      days: z.array(z.number().int().min(0).max(6)).min(1, 'Attiva almeno un giorno di consegna'),
      horizon: z.number().int().min(3).max(60),
      lead: z.number().int().min(0).max(7),
    }).parse(req.body);
    const t = tenantOf(req);
    return tx(async (c) => {
      await saveBooking(c, t, { horizon: b.horizon, lead: b.lead });
      await replaceTemplates(c, t, b.days.flatMap((weekday) => b.bands.map((x) => ({ weekday, start_time: x.start, end_time: x.end, capacity: x.cap }))));
      const r = await generateSlots(c, t);
      return { overbooked: r.overbooked.map((s) => ({ date: s.date, bandId: bandId(s.start_time, s.end_time), booked: s.booked, capacity: s.capacity })) };
    });
  });

  app.put('/area', async (req) => {
    const b = z.object({ on: z.boolean(), list: z.string().max(20000) }).parse(req.body);
    const { bad } = parseArea(b.list);
    if (bad.length) throw new DomainError('invalid_area', `Non riconosciuto: ${bad.slice(0, 3).join(', ')}.`, 422);
    await saveArea(pool, tenantOf(req), b);
    return b;
  });

  app.put('/messages', async (req) => {
    const b = z.object({ texts: z.record(z.string()) }).parse(req.body);
    const keys = Object.keys(MESSAGE_DEFAULTS) as (keyof Messages)[];
    const texts = Object.fromEntries(keys.map((k) => [k, b.texts[k] ?? MESSAGE_DEFAULTS[k]])) as Messages;
    const err = validateMessages(texts);
    if (err) throw new DomainError('invalid_messages', err, 422);
    await saveMessages(pool, tenantOf(req), texts);
    return { texts };
  });
}

