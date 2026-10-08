import type { Db } from '../lib/db.js';
import { addDays, todayLocal, weekday } from '../lib/dates.js';
import { getBooking } from './settings.js';

export interface Slot {
  id: string;
  tenant_id: string;
  date: string;
  start_time: string;
  end_time: string;
  capacity: number;
  booked: number;
}

export interface SlotTemplateInput {
  weekday: number;
  start_time: string;
  end_time: string;
  capacity: number;
  active?: boolean;
}

/** Canale Postgres usato per avvisare le pagine cliente aperte (SSE). */
export const SLOT_CHANNEL = 'slot_changed';

async function notifyChange(db: Db, slotIds: string[]) {
  if (slotIds.length) await db.query('SELECT pg_notify($1, $2)', [SLOT_CHANNEL, JSON.stringify(slotIds)]);
}

/**
 * Occupa un posto. Una sola istruzione condizionata: se due richieste arrivano
 * insieme sull'ultimo posto, Postgres serializza le UPDATE sulla stessa riga
 * e solo la prima trova booked < capacity.
 */
export async function reserve(db: Db, slotId: string): Promise<boolean> {
  const r = await db.query('UPDATE slots SET booked = booked + 1 WHERE id = $1 AND booked < capacity RETURNING id', [slotId]);
  if (r.rowCount) await notifyChange(db, [slotId]);
  return r.rowCount === 1;
}

export async function release(db: Db, slotId: string): Promise<void> {
  await db.query('UPDATE slots SET booked = GREATEST(booked - 1, 0) WHERE id = $1', [slotId]);
  await notifyChange(db, [slotId]);
}

export async function getSlot(db: Db, id: string): Promise<Slot | null> {
  const r = await db.query<Slot>('SELECT id, tenant_id, date, start_time, end_time, capacity, booked FROM slots WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/** Slot di un ambiente prenotabili dal cliente, con posti liberi. */
export async function availability(db: Db, tenantId: string, from: string, to: string): Promise<(Slot & { free: number })[]> {
  const r = await db.query<Slot & { free: number }>(
    `SELECT id, tenant_id, date, start_time, end_time, capacity, booked, GREATEST(capacity - booked, 0)::int AS free
       FROM slots WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 AND capacity > 0
      ORDER BY date, start_time`,
    [tenantId, from, to],
  );
  return r.rows;
}

/** Giorni che il cliente può scegliere: dal preavviso minimo per "horizon" giorni. */
export async function bookingWindow(db: Db, tenantId: string) {
  const b = await getBooking(db, tenantId);
  const from = addDays(todayLocal(), b.lead);
  return { from, to: addDays(from, b.horizon - 1) };
}

/**
 * Crea o aggiorna gli slot concreti di un ambiente per i prossimi giorni a partire dalle fasce
 * ricorrenti e dalle eccezioni. Gli slot non più previsti vengono eliminati solo se vuoti;
 * quelli con prenotazioni restano e vengono restituiti come conflitti da gestire.
 */
export async function generateSlots(db: Db, tenantId: string, from = todayLocal(), days?: number) {
  if (!days) { const b = await getBooking(db, tenantId); days = b.horizon + b.lead + 21; }
  const templates = (
    await db.query<{ id: string; weekday: number; start_time: string; end_time: string; capacity: number }>(
      'SELECT id, weekday, start_time, end_time, capacity FROM slot_templates WHERE tenant_id = $1 AND active',
      [tenantId],
    )
  ).rows;
  const to = addDays(from, days - 1);
  const overrides = new Map(
    (
      await db.query<{ date: string; template_id: string; capacity: number }>(
        `SELECT o.date, o.template_id, o.capacity FROM slot_overrides o JOIN slot_templates t ON t.id = o.template_id
          WHERE t.tenant_id = $1 AND o.date BETWEEN $2 AND $3`,
        [tenantId, from, to],
      )
    ).rows.map((o) => [`${o.date}|${o.template_id}`, o.capacity]),
  );

  const dates: string[] = [], starts: string[] = [], ends: string[] = [], tpl: string[] = [], caps: number[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    for (const t of templates) {
      if (t.weekday !== weekday(d)) continue;
      dates.push(d); starts.push(t.start_time); ends.push(t.end_time); tpl.push(t.id);
      caps.push(overrides.get(`${d}|${t.id}`) ?? t.capacity);
    }
  }

  await db.query(
    `INSERT INTO slots (tenant_id, date, start_time, end_time, template_id, capacity)
     SELECT $6::uuid, * FROM unnest($1::date[], $2::time[], $3::time[], $4::uuid[], $5::int[])
     ON CONFLICT (tenant_id, date, start_time, end_time)
     DO UPDATE SET capacity = EXCLUDED.capacity, template_id = EXCLUDED.template_id`,
    [dates, starts, ends, tpl, caps, tenantId],
  );

  // Slot che non corrispondono più a nessuna fascia
  const stale = await db.query<Slot>(
    `SELECT s.id, s.tenant_id, s.date, s.start_time, s.end_time, s.capacity, s.booked FROM slots s
      WHERE s.tenant_id = $6 AND s.date BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM unnest($3::date[], $4::time[], $5::time[]) AS e(d, st, en)
                         WHERE e.d = s.date AND e.st = s.start_time AND e.en = s.end_time)`,
    [from, to, dates, starts, ends, tenantId],
  );
  const emptyIds = stale.rows.filter((s) => s.booked === 0).map((s) => s.id);
  if (emptyIds.length) {
    await db.query(
      `DELETE FROM slots WHERE id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.slot_id = slots.id OR d.proposed_slot_id = slots.id)`,
      [emptyIds],
    );
  }
  // Senza fascia ma con prenotazioni: capienza azzerata (nessun nuovo posto), restano visibili all'operatore
  const orphaned = stale.rows.filter((s) => s.booked > 0);
  if (orphaned.length) await db.query('UPDATE slots SET capacity = 0 WHERE id = ANY($1::uuid[])', [orphaned.map((s) => s.id)]);

  const overbooked = (
    await db.query<Slot>(
      `SELECT id, tenant_id, date, start_time, end_time, capacity, booked FROM slots
        WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 AND booked > capacity ORDER BY date, start_time`,
      [tenantId, from, to],
    )
  ).rows;

  await db.query('SELECT pg_notify($1, $2)', [SLOT_CHANNEL, '"all"']);
  return { generated: dates.length, overbooked };
}

/** Sostituisce l'intero set di fasce ricorrenti di un ambiente. */
export async function replaceTemplates(db: Db, tenantId: string, items: SlotTemplateInput[]) {
  const keep: string[] = [];
  for (const t of items) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO slot_templates (tenant_id, weekday, start_time, end_time, capacity, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, weekday, start_time, end_time) DO UPDATE SET capacity = EXCLUDED.capacity, active = EXCLUDED.active
       RETURNING id`,
      [tenantId, t.weekday, t.start_time, t.end_time, t.capacity, t.active ?? true],
    );
    keep.push(r.rows[0]!.id);
  }
  await db.query('UPDATE slot_templates SET active = false WHERE tenant_id = $1 AND NOT (id = ANY($2::uuid[]))', [tenantId, keep]);
}

export const DEFAULT_BANDS = [['08:00', '11:00', 6], ['11:00', '14:00', 5], ['14:00', '17:00', 6], ['17:00', '20:00', 4]] as const;

/** Fasce standard per un ambiente nuovo: lun–sab, 4 fasce. Si cambiano dal pannello. */
export async function ensureDefaultTemplates(db: Db, tenantId: string) {
  const n = (await db.query('SELECT 1 FROM slot_templates WHERE tenant_id = $1 LIMIT 1', [tenantId])).rowCount;
  if (n) return false;
  await replaceTemplates(db, tenantId, [1, 2, 3, 4, 5, 6].flatMap((weekday) =>
    DEFAULT_BANDS.map(([s, e, cap]) => ({ weekday, start_time: s, end_time: e, capacity: cap }))));
  return true;
}

/** Tutti gli ambienti attivi: per la generazione notturna degli slot. */
export async function activeTenantIds(db: Db): Promise<string[]> {
  return (await db.query<{ id: string }>('SELECT id FROM tenants WHERE NOT suspended AND subscription_end >= current_date')).rows.map((r) => r.id);
}
