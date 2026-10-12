import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../lib/db.js';
import { emailEnabled } from '../config.js';
import { addDays, hhmm, todayLocal } from '../lib/dates.js';
import { DomainError } from '../lib/errors.js';
import { actorOf, requireOperator, tenantOf } from '../lib/auth.js';
import {
  answerPin, markNotSent, bookSlot, confirmDelivery, declineDelivery, createDelivery, deleteDelivery, deliveryEvents, getDelivery, listDeliveries,
  markDelivered, markFailedLetCustomerChoose, type DeliveryView, type Status,
} from '../domain/deliveries.js';
import { generateSlots, replaceTemplates } from '../domain/slots.js';
import {
  getArea, getBooking, getMessages, parseArea, saveArea, saveBooking, saveMessages, validateMessages, MESSAGE_DEFAULTS, type Messages,
} from '../domain/settings.js';
import { createToken, customerUrl } from '../domain/tokens.js';
import { getFeatures, getFlow, getReportSetting, noSendMatch, saveFlow, saveReportSetting } from '../domain/settings.js';
import { openSlots, parseWorkbook, personKey, planSlots, templateWorkbook, type ImportRow, type PlannedRow } from '../domain/importer.js';
import { createReport, deleteReport, getReportFile, listReports } from '../domain/report.js';
import { enqueue } from '../jobs/queue.js';

/**
 * API del pannello operatori. I dati hanno la stessa forma usata dalla demo:
 * stati in italiano, fascia identificata da "HH:MM-HH:MM".
 */
const IT: Record<Status, string> = {
  proposed: 'inviato', pin_check: 'attesa_pin', confirmed: 'confermato', to_reschedule: 'da_riprogrammare', rescheduled: 'riprogrammato',
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
    city: d.city ?? '',
    province: d.province ?? '',
    cod: Number(d.cod_amount) || 0,
    pickup: d.pickup,
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

/** Numero d'ordine generato quando non viene indicato. */
async function newOrderRef(tenantId: string, taken?: Set<string>) {
  for (;;) {
    const ref = `ORD-${Math.floor(100000 + Math.random() * 899999)}`;
    if (taken?.has(ref.toLowerCase())) continue;
    const r = await pool.query('SELECT 1 FROM deliveries WHERE tenant_id = $1 AND order_ref = $2', [tenantId, ref]);
    if (!r.rowCount) { taken?.add(ref.toLowerCase()); return ref; }
  }
}
async function existingRefs(tenantId: string) {
  const r = await pool.query<{ ref: string }>('SELECT lower(order_ref) AS ref FROM deliveries WHERE tenant_id = $1', [tenantId]);
  return new Set(r.rows.map((x) => x.ref));
}
/** Clienti con una consegna ancora aperta (per riconoscere i doppioni senza numero d'ordine). */
async function openPeople(tenantId: string) {
  const r = await pool.query<{ name: string; address: string }>(
    `SELECT c.name, d.address FROM deliveries d JOIN customers c ON c.id = d.customer_id
      WHERE d.tenant_id = $1 AND d.status NOT IN ('delivered','cancelled')`, [tenantId]);
  return new Set(r.rows.map((x) => personKey(x.name, x.address)));
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment = (name: string) => `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`;

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
      flow: await getFlow(pool, t),
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
    const excluded = noSendMatch((await getArea(pool, t)).noSend, { cap: b.cap });
    const id = await createDelivery(t, {
      order_ref: await newOrderRef(t),
      customer: { name: b.name, phone_e164: phone, email: b.email || null, consent_whatsapp: Boolean(phone) },
      address: b.address, cap: b.cap, product: b.product || null,
      slot_id: await slotIdFor(t, b.date, b.bandId),
    }, actorOf(req), { notSent: excluded ?? undefined });
    if (!excluded) await enqueue.proposal(id);
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
    const { answer } = z.object({ answer: z.enum(['yes', 'no', 'pin_yes', 'pin_no']) }).parse(req.body);
    const t = tenantOf(req), actor = `customer:pannello (${actorOf(req)})`;
    if (answer === 'yes') { if ((await confirmDelivery(id, actor, t)) === 'confirmed') await enqueue.afterConfirm(id); } // con il PIN: la domanda si risponde nell'anteprima
    else if (answer === 'no') { await declineDelivery(id, actor, t); await enqueue.afterDecline(id); }
    else if ((await answerPin(id, answer === 'pin_yes', actor, t)) === 'confirmed') await enqueue.afterConfirm(id);
    else await enqueue.afterDecline(id);
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

  /* ---------- importazione da Excel ---------- */

  app.get('/import/template', async (req, reply) => {
    const sch = await getSchedule(tenantOf(req));
    const buf = await templateWorkbook(sch.bands.map((b) => b.id));
    return reply.header('content-type', XLSX).header('content-disposition', attachment('modello_consegne.xlsx')).send(buf);
  });

  /** Legge il file e mostra cosa verrà inviato, senza creare nulla. */
  app.post('/import/preview', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const b = z.object({ file: z.string().min(1).max(14 * 1024 * 1024) }).parse(req.body);
    const t = tenantOf(req);
    let parsed;
    try { parsed = await parseWorkbook(Buffer.from(b.file, 'base64')); }
    catch (err) { throw new DomainError('invalid_file', (err as Error).message, 422); }
    if (parsed.missing.length) throw new DomainError('missing_columns', `Nel file mancano le colonne: ${parsed.missing.join(', ')}. Scarica il modello per vedere come deve essere.`, 422);
    const open = await openSlots(pool, t);
    const noSend = (await getArea(pool, t)).noSend;
    // gli esclusi non ricevono il messaggio: non serve una fascia e non occupano posti
    const planned = planSlots(parsed.rows, open, await existingRefs(t), await openPeople(t), (r) => Boolean(noSendMatch(noSend, r)));
    const sheets = [...new Set([...planned, ...parsed.errors].map((r) => r.sheet))];
    const rows = [...planned, ...parsed.errors]
      .sort((a, b2) => sheets.indexOf(a.sheet) - sheets.indexOf(b2.sheet) || a.line - b2.line)
      .map((r) => ({ ...r, noSend: noSendMatch(noSend, r) }));
    if (!rows.length) throw new DomainError('empty_file', 'Il file non contiene consegne: sotto le intestazioni non ci sono righe compilate.', 422);
    // fasce disponibili, per scegliere data e fascia riga per riga prima dell'invio
    const slots = open.slots.map((s) => ({ date: s.date, bandId: `${s.start}-${s.end}`, free: s.free }));
    return { rows, ok: rows.filter((r) => !r.errors.length && (!r.slotIssue || r.noSend)).length, first: open.first, slots };
  });

  /** Crea le consegne valide e invia a tutti il messaggio. Le fasce vengono ricontrollate al momento. */
  app.post('/import/commit', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const row = z.object({
      line: z.number().int(), sheet: z.string().max(100).default(''), name: z.string().trim().min(1).max(200), address: z.string().trim().min(3).max(300),
      cap: z.string().regex(/^(\d{5})?$/), phone: z.string().regex(/^(\+\d{8,15})?$/), email: z.string().max(200),
      product: z.string().max(120), order_ref: z.string().max(60),
      city: z.string().max(120).default(''), province: z.string().max(4).default(''),
      cod_amount: z.number().min(0).max(1_000_000).default(0), pickup: z.boolean().default(false),
      source: z.array(z.object({ h: z.string().max(200), v: z.unknown() })).max(200).default([]),
      date: isoDate.nullable(), band: time.nullable(),
    }).refine((r) => r.phone || r.email, 'Serve almeno un contatto');
    const b = z.object({ rows: z.array(row).min(1).max(1000) }).parse(req.body);
    const t = tenantOf(req), actor = `${actorOf(req)} (Excel)`;
    const refs = await existingRefs(t), people = await openPeople(t);
    const noSend = (await getArea(pool, t)).noSend;
    const results: { line: number; sheet: string; ok: boolean; error?: string; name: string; notSent?: boolean; slot?: { date: string; bandId: string } }[] = [];
    for (const r of b.rows as ImportRow[]) {
      // ricalcola lo slot con i posti di adesso (nel frattempo altri potrebbero averli presi)
      const open = await openSlots(pool, t);
      const excluded = noSendMatch(noSend, r);
      const [plan] = planSlots([r], open, refs, people, () => Boolean(excluded));
      if (excluded && plan && !plan.errors.length && !plan.slot) {
        // senza messaggio: serve solo una data di riferimento (la prima disponibile); il posto non viene occupato
        const ref0 = open.slots.find((s) => s.date >= open.first) ?? open.slots[0];
        if (ref0) plan.slot = { date: ref0.date, bandId: `${ref0.start}-${ref0.end}` };
      }
      if (!plan || plan.errors.length || !plan.slot) { results.push({ line: r.line, sheet: r.sheet, ok: false, name: r.name, error: [...(plan?.errors ?? []), plan?.slotIssue].filter(Boolean).join('; ') || 'non inviata' }); continue; }
      try {
        const ref = r.order_ref || await newOrderRef(t, refs);
        const id = await createDelivery(t, {
          order_ref: ref,
          customer: { name: r.name, phone_e164: r.phone || null, email: r.email || null, consent_whatsapp: Boolean(r.phone) },
          address: r.address, cap: r.cap || null, product: r.product || null,
          city: r.city || null, province: r.province || null, cod_amount: r.cod_amount, pickup: r.pickup, source: r.source,
          slot_id: await slotIdFor(t, plan.slot.date, plan.slot.bandId),
        }, actor, { notSent: excluded ?? undefined });
        refs.add(ref.toLowerCase()); people.add(personKey(r.name, r.address));
        if (!excluded) await enqueue.proposal(id);
        results.push({ line: r.line, sheet: r.sheet, ok: true, name: r.name, slot: plan.slot, notSent: Boolean(excluded) });
      } catch (err) {
        results.push({ line: r.line, sheet: r.sheet, ok: false, name: r.name, error: err instanceof DomainError ? err.message : 'errore imprevisto' });
      }
    }
    return { sent: results.filter((x) => x.ok && !x.notSent).length, notSent: results.filter((x) => x.notSent).length, results };
  });

  /* ---------- report Excel periodico ---------- */

  app.get('/reports', async (req) => {
    const t = tenantOf(req);
    const tenant = (await pool.query<{ email: string }>('SELECT email FROM tenants WHERE id = $1', [t])).rows[0];
    return { setting: await getReportSetting(pool, t), features: await getFeatures(pool, t), tenantEmail: tenant?.email ?? '', emailReady: emailEnabled(), reports: await listReports(pool, t) };
  });

  app.put('/reports/setting', async (req) => {
    const b = z.object({
      hours: z.number().int().min(0, 'Minimo 1 ora (0 per spegnere)').max(720, 'Massimo 720 ore (30 giorni)'),
      email: z.boolean(),
      to: z.string().trim().max(200).refine((v) => !v || z.string().email().safeParse(v).success, 'Email del destinatario non valida'),
      at: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, 'Orario non valido: usa il formato 08:30').optional().default(''),
    }).parse(req.body);
    const t = tenantOf(req);
    // l'orario fisso vale solo se la funzione è attiva per questo ambiente; altrimenti resta quello salvato
    const s = { ...b, at: (await getFeatures(pool, t)).reportAtTime ? b.at : (await getReportSetting(pool, t)).at };
    await saveReportSetting(pool, t, s);
    return s;
  });

  app.post('/reports', async (req) => createReport(pool, tenantOf(req), 'manual'));

  app.delete('/reports/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!(await deleteReport(pool, tenantOf(req), id))) throw new DomainError('not_found', 'Report non trovato.', 404);
    return reply.code(204).send();
  });

  app.get('/reports/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const f = await getReportFile(pool, tenantOf(req), id);
    if (!f) throw new DomainError('not_found', 'Report non trovato: è stato cancellato o sono passate più di 48 ore.', 404);
    return reply.header('content-type', XLSX).header('content-disposition', attachment(f.filename)).send(f.data);
  });

  app.put('/flow', async (req) => {
    const b = z.object({ askPin: z.boolean() }).parse(req.body);
    await saveFlow(pool, tenantOf(req), b);
    return b;
  });

  app.put('/area', async (req) => {
    const b = z.object({ on: z.boolean(), list: z.string().max(20000), callAll: z.boolean().optional().default(false), noSend: z.string().max(20000).optional().default('') }).parse(req.body);
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

