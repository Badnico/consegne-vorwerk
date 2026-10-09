import type pg from 'pg';
import { pool, tx, type Db } from '../lib/db.js';
import { DomainError, invalidState, notFound, slotFull } from '../lib/errors.js';
import { todayLocal } from '../lib/dates.js';
import { getSlot, release, reserve, bookingWindow } from './slots.js';
import { extendToken } from './tokens.js';
import { canSelfBook, getArea } from './settings.js';

export type Status =
  | 'proposed' | 'confirmed' | 'to_reschedule' | 'rescheduled'
  | 'out_of_area' | 'no_response' | 'cancelled' | 'delivered';

/** Stati in cui la consegna occupa un posto nel suo slot */
export const HOLDS_SEAT: Status[] = ['proposed', 'confirmed', 'rescheduled', 'delivered'];

export interface DeliveryView {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_email: string;
  order_ref: string;
  status: Status;
  address: string;
  cap: string | null;
  product: string | null;
  customer_id: string;
  customer_name: string;
  phone_e164: string | null;
  email: string | null;
  consent_whatsapp: boolean;
  slot_id: string | null;
  proposed_slot_id: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  proposed_date: string;
  proposed_start: string;
  proposed_end: string;
  reminders_sent: number;
  failed_attempts: number;
  delivered_at: string | null;
  created_at: string;
}

export interface NewDelivery {
  order_ref: string;
  customer: { name: string; phone_e164?: string | null; email?: string | null; consent_whatsapp?: boolean };
  address: string;
  cap?: string | null;
  product?: string | null;
  slot_id: string;
}

const VIEW_SQL = `
  SELECT d.id, d.tenant_id, t.name AS tenant_name, t.email AS tenant_email, d.order_ref, d.status, d.address, d.cap, d.product, d.customer_id, d.slot_id, d.proposed_slot_id,
         d.reminders_sent, d.failed_attempts, d.delivered_at, d.created_at,
         c.name AS customer_name, c.phone_e164, c.email, c.consent_whatsapp,
         s.date, s.start_time, s.end_time,
         p.date AS proposed_date, p.start_time AS proposed_start, p.end_time AS proposed_end
    FROM deliveries d
    JOIN tenants t ON t.id = d.tenant_id
    JOIN customers c ON c.id = d.customer_id
    JOIN slots p ON p.id = d.proposed_slot_id
    LEFT JOIN slots s ON s.id = COALESCE(d.slot_id, d.proposed_slot_id)`;

/** Con tenantId, una consegna di un altro ambiente risulta inesistente. */
export async function getDelivery(db: Db, id: string, tenantId?: string): Promise<DeliveryView> {
  const r = await db.query<DeliveryView>(`${VIEW_SQL} WHERE d.id = $1`, [id]);
  if (!r.rows[0] || (tenantId && r.rows[0].tenant_id !== tenantId)) throw notFound('Consegna');
  return r.rows[0];
}

export async function listDeliveries(db: Db, tenantId: string, f: { from?: string; to?: string; status?: Status; openOrSince?: string }) {
  const where: string[] = ['d.tenant_id = $1'], args: unknown[] = [tenantId];
  if (f.from) { args.push(f.from); where.push(`s.date >= $${args.length}`); }
  if (f.to) { args.push(f.to); where.push(`s.date <= $${args.length}`); }
  if (f.status) { args.push(f.status); where.push(`d.status = $${args.length}`); }
  // Per il pannello: tutte le consegne aperte + quelle chiuse di recente
  if (f.openOrSince) { args.push(f.openOrSince); where.push(`(d.status NOT IN ('delivered','cancelled') OR s.date >= $${args.length})`); }
  const r = await db.query<DeliveryView>(
    `${VIEW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.date NULLS LAST, s.start_time, d.created_at LIMIT 2000`,
    args,
  );
  return r.rows;
}

/** Blocca la riga della consegna e verifica che lo stato consenta l'azione. */
async function lockFor(client: pg.PoolClient, id: string, allowed: Status[], action: string, tenantId?: string) {
  const r = await client.query<{ tenant_id: string; status: Status; slot_id: string | null; cap: string | null; failed_attempts: number }>(
    'SELECT tenant_id, status, slot_id, cap, failed_attempts FROM deliveries WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = r.rows[0];
  if (!row || (tenantId && row.tenant_id !== tenantId)) throw notFound('Consegna');
  if (!allowed.includes(row.status)) throw invalidState(row.status, action);
  return row;
}

async function logEvent(db: Db, id: string, from: Status | null, to: Status, actor: string, note?: string) {
  await db.query(
    'INSERT INTO delivery_events (delivery_id, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5)',
    [id, from, to, actor, note ?? null],
  );
}

/** Crea la consegna occupando subito il posto nello slot proposto. */
export async function createDelivery(tenantId: string, input: NewDelivery, actor: string): Promise<string> {
  return tx(async (c) => {
    const slot = await getSlot(c, input.slot_id);
    if (!slot || slot.tenant_id !== tenantId) throw notFound('Slot');
    const existing = await c.query('SELECT 1 FROM deliveries WHERE tenant_id = $1 AND order_ref = $2', [tenantId, input.order_ref]);
    if (existing.rowCount) throw new DomainError('duplicate_order', `L'ordine ${input.order_ref} esiste già.`);
    if (!(await reserve(c, slot.id))) throw slotFull();

    const cust = await c.query<{ id: string }>(
      'INSERT INTO customers (tenant_id, name, phone_e164, email, consent_whatsapp) VALUES ($5, $1, $2, $3, $4) RETURNING id',
      [input.customer.name, input.customer.phone_e164 ?? null, input.customer.email ?? null, input.customer.consent_whatsapp ?? false, tenantId],
    );
    const d = await c.query<{ id: string }>(
      `INSERT INTO deliveries (tenant_id, order_ref, customer_id, address, cap, product, slot_id, proposed_slot_id, status)
       VALUES ($7, $1, $2, $3, $4, $5, $6, $6, 'proposed') RETURNING id`,
      [input.order_ref, cust.rows[0]!.id, input.address, input.cap ?? null, input.product ?? null, slot.id, tenantId],
    );
    const id = d.rows[0]!.id;
    await logEvent(c, id, null, 'proposed', actor);
    return id;
  });
}

/** Il cliente dice Sì. */
export async function confirmDelivery(id: string, actor = 'customer', tenantId?: string) {
  return tx(async (c) => {
    const row = await lockFor(c, id, ['proposed', 'no_response'], 'conferma', tenantId);
    if (row.status === 'no_response' && !row.slot_id) throw invalidState(row.status, 'conferma');
    await c.query(`UPDATE deliveries SET status = 'confirmed', updated_at = now() WHERE id = $1`, [id]);
    await logEvent(c, id, row.status, 'confirmed', actor);
  });
}

/**
 * Il cliente dice No: il posto si libera subito.
 * Dentro l'area servita può scegliere la nuova data; fuori passa all'operatore.
 * Restituisce lo stato finale.
 */
export async function declineDelivery(id: string, actor = 'customer', tenantId?: string): Promise<Status> {
  return tx(async (c) => {
    const row = await lockFor(c, id, ['proposed', 'confirmed', 'rescheduled', 'no_response'], 'rifiuto', tenantId);
    if (row.slot_id) await release(c, row.slot_id);
    const next: Status = canSelfBook(await getArea(c, row.tenant_id), row.cap) ? 'to_reschedule' : 'out_of_area';
    await c.query(`UPDATE deliveries SET status = $2, slot_id = NULL, updated_at = now() WHERE id = $1`, [id, next]);
    await logEvent(c, id, row.status, next, actor, next === 'out_of_area' ? `CAP ${row.cap ?? 'mancante'} fuori area` : undefined);
    return next;
  });
}

/**
 * Nuovo slot per una consegna. Occupa il nuovo posto prima di liberare il vecchio:
 * se il nuovo è pieno non cambia nulla.
 * Il cliente può scegliere solo dentro la finestra di prenotazione e solo se è nell'area;
 * l'operatore può assegnare qualunque slot da oggi in poi, anche per spostare una consegna confermata.
 */
export async function bookSlot(id: string, slotId: string, actor = 'customer', opts: { failed?: boolean; tenantId?: string } = {}) {
  const byOperator = actor.startsWith('operator');
  return tx(async (c) => {
    const allowed: Status[] = byOperator
      ? ['to_reschedule', 'rescheduled', 'confirmed', 'out_of_area', 'no_response', 'proposed']
      : ['to_reschedule', 'rescheduled', 'no_response'];
    const row = await lockFor(c, id, allowed, 'prenotazione', opts.tenantId);
    if (row.slot_id === slotId && !opts.failed) return;
    const slot = await getSlot(c, slotId);
    if (!slot || slot.tenant_id !== row.tenant_id) throw new DomainError('slot_not_bookable', 'Questo slot non esiste.', 422);
    if (byOperator) {
      if (slot.date < todayLocal()) throw new DomainError('slot_not_bookable', 'Non si può assegnare una data passata.', 422);
    } else {
      const win = await bookingWindow(c, row.tenant_id);
      if (slot.date < win.from || slot.date > win.to) throw new DomainError('slot_not_bookable', 'Questo slot non è prenotabile.', 422);
      if (!canSelfBook(await getArea(c, row.tenant_id), row.cap)) throw new DomainError('out_of_area', 'Per questo indirizzo la data va concordata con un operatore.', 422);
    }
    if (row.slot_id !== slotId) {
      if (!(await reserve(c, slotId))) throw slotFull();
      if (row.slot_id) await release(c, row.slot_id);
    }
    await c.query(
      `UPDATE deliveries SET status = 'rescheduled', slot_id = $2, failed_attempts = failed_attempts + $3, updated_at = now() WHERE id = $1`,
      [id, slotId, opts.failed ? 1 : 0],
    );
    await extendToken(c, id, slot.date);
    await logEvent(c, id, row.status, 'rescheduled', actor,
      `${opts.failed ? 'Consegna non riuscita. ' : ''}${slot.date} ${slot.start_time}-${slot.end_time}`);
  });
}

/** Esito: consegna avvenuta. */
export async function markDelivered(id: string, actor: string, tenantId?: string) {
  return tx(async (c) => {
    const row = await lockFor(c, id, ['confirmed', 'rescheduled'], 'consegnata', tenantId);
    await c.query(`UPDATE deliveries SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await logEvent(c, id, row.status, 'delivered', actor);
  });
}

/**
 * Esito: consegna non avvenuta, il cliente sceglie una nuova data (o passa all'operatore se fuori area).
 * Per far scegliere la data all'operatore si usa bookSlot con failed: true.
 */
export async function markFailedLetCustomerChoose(id: string, actor: string, tenantId?: string): Promise<Status> {
  return tx(async (c) => {
    const row = await lockFor(c, id, ['confirmed', 'rescheduled'], 'non consegnata', tenantId);
    if (row.slot_id) await release(c, row.slot_id);
    const next: Status = canSelfBook(await getArea(c, row.tenant_id), row.cap) ? 'to_reschedule' : 'out_of_area';
    await c.query(
      `UPDATE deliveries SET status = $2, slot_id = NULL, failed_attempts = failed_attempts + 1, updated_at = now() WHERE id = $1`,
      [id, next],
    );
    await logEvent(c, id, row.status, next, actor, 'Consegna non riuscita');
    return next;
  });
}

/** Elimina definitivamente la consegna (e libera il posto se lo occupava ancora). */
export async function deleteDelivery(id: string, tenantId?: string) {
  return tx(async (c) => {
    const r = await c.query<{ tenant_id: string; status: Status; slot_id: string | null; customer_id: string }>(
      'SELECT tenant_id, status, slot_id, customer_id FROM deliveries WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = r.rows[0];
    if (!row || (tenantId && row.tenant_id !== tenantId)) throw notFound('Consegna');
    if (row.slot_id && [...HOLDS_SEAT, 'no_response'].includes(row.status)) await release(c, row.slot_id);
    await c.query('DELETE FROM deliveries WHERE id = $1', [id]);
    await c.query('DELETE FROM customers c WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM deliveries WHERE customer_id = c.id)', [row.customer_id]);
  });
}

/** Scadenza senza risposta: la consegna passa all'operatore. Il posto proposto resta occupato. */
export async function markNoResponse(id: string) {
  return tx(async (c) => {
    const row = await lockFor(c, id, ['proposed', 'to_reschedule'], 'scadenza');
    await c.query(`UPDATE deliveries SET status = 'no_response', updated_at = now() WHERE id = $1`, [id]);
    await logEvent(c, id, row.status, 'no_response', 'system');
  });
}

export async function incrementReminders(id: string) {
  await pool.query('UPDATE deliveries SET reminders_sent = reminders_sent + 1 WHERE id = $1', [id]);
}

export async function deliveryEvents(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { t: string; ev: string }[]>();
  const r = await db.query<{ delivery_id: string; created_at: Date; to_status: Status; actor: string; note: string | null }>(
    'SELECT delivery_id, created_at, to_status, actor, note FROM delivery_events WHERE delivery_id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  );
  const out = new Map<string, { t: string; ev: string }[]>();
  for (const e of r.rows) {
    const list = out.get(e.delivery_id) ?? [];
    list.push({ t: e.created_at.toISOString(), ev: `${e.to_status}${e.note ? ': ' + e.note : ''} (${e.actor})` });
    out.set(e.delivery_id, list);
  }
  return out;
}

