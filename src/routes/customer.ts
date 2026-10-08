import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../lib/db.js';
import { resolveToken } from '../domain/tokens.js';
import { bookSlot, confirmDelivery, declineDelivery, getDelivery, type DeliveryView } from '../domain/deliveries.js';
import { availability, bookingWindow } from '../domain/slots.js';
import { fillText, getMessages } from '../domain/settings.js';
import { messageVars } from '../notify/notifier.js';
import { subscribe } from '../lib/live.js';
import { hhmm } from '../lib/dates.js';
import { enqueue } from '../jobs/queue.js';
import { customerPage } from './customer-page.js';

const params = z.object({ token: z.string() });

/** Solo ciò che serve al cliente: niente telefono, email o storico. Testi già compilati con i suoi dati. */
async function publicView(d: DeliveryView) {
  const m = await getMessages(pool, d.tenant_id);
  const cur = messageVars(d, 'current'), prop = messageVars(d, 'proposed');
  const f = (k: keyof typeof m, v = cur) => fillText(m[k], v);
  return {
    order_ref: d.order_ref,
    status: d.status,
    first_name: cur.nome,
    product: d.product,
    address_short: d.address.split(',')[0],
    slot: d.date && d.slot_id ? { id: d.slot_id, date: d.date, start: hhmm(d.start_time!), end: hhmm(d.end_time!) } : null,
    proposed: { date: d.proposed_date, start: hhmm(d.proposed_start), end: hhmm(d.proposed_end) },
    texts: {
      body: f('mail_body', prop),
      question: f('mail_question', prop),
      yes: f('mail_yes', prop),
      no: f('mail_no', prop),
      confirmed: f('mail_confirmed'),
      rescheduled: f('mail_rescheduled'),
      out_of_area: f('mail_out_area'),
      page_title: f('page_title'),
      page_note: f('page_note'),
      page_button: m.page_button, // {data} e {fascia} li completa la pagina con lo slot scelto
    },
  };
}

const noStore = (reply: FastifyReply) =>
  reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex');

export async function customerRoutes(app: FastifyInstance) {
  // TODO produzione: limite di richieste per token e per IP (es. @fastify/rate-limit)

  app.get('/r/:token', async (req, reply) => {
    const { token } = params.parse(req.params);
    let state: Awaited<ReturnType<typeof publicView>> | null = null;
    try {
      state = await publicView(await getDelivery(pool, await resolveToken(pool, token)));
    } catch {
      state = null;
    }
    noStore(reply)
      .header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
      .type('text/html; charset=utf-8');
    return customerPage(state);
  });

  app.get('/r/:token/state', async (req, reply) => {
    const { token } = params.parse(req.params);
    noStore(reply);
    return publicView(await getDelivery(pool, await resolveToken(pool, token)));
  });

  app.post('/r/:token/confirm', async (req, reply) => {
    const { token } = params.parse(req.params);
    const id = await resolveToken(pool, token);
    await confirmDelivery(id, 'customer:web');
    await enqueue.afterConfirm(id);
    noStore(reply);
    return publicView(await getDelivery(pool, id));
  });

  app.post('/r/:token/decline', async (req, reply) => {
    const { token } = params.parse(req.params);
    const id = await resolveToken(pool, token);
    await declineDelivery(id, 'customer:web');
    await enqueue.afterDecline(id); // link di promemoria o messaggio "fuori area"
    noStore(reply);
    return publicView(await getDelivery(pool, id));
  });

  app.get('/r/:token/availability', async (req, reply) => {
    const { token } = params.parse(req.params);
    const d = await getDelivery(pool, await resolveToken(pool, token));
    const { from, to } = await bookingWindow(pool, d.tenant_id);
    const slots = await availability(pool, d.tenant_id, from, to);
    noStore(reply);
    return {
      from,
      to,
      slots: slots.map((s) => ({ id: s.id, date: s.date, start: hhmm(s.start_time), end: hhmm(s.end_time), free: s.free, mine: s.id === d.slot_id })),
    };
  });

  app.get('/r/:token/availability/stream', async (req, reply) => {
    const { token } = params.parse(req.params);
    await resolveToken(pool, token);
    reply.hijack();
    subscribe(reply.raw);
  });

  app.post('/r/:token/book', async (req, reply) => {
    const { token } = params.parse(req.params);
    const { slot_id } = z.object({ slot_id: z.string().uuid() }).parse(req.body);
    const id = await resolveToken(pool, token);
    await bookSlot(id, slot_id, 'customer:web');
    await enqueue.afterConfirm(id);
    noStore(reply);
    return publicView(await getDelivery(pool, id));
  });
}
