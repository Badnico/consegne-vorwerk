import type { Db } from '../lib/db.js';
import type { TimingSetting } from './settings.js';

/**
 * Sollecito e "Senza risposta" calcolati ogni minuto con i tempi ATTUALI dell'azienda:
 * se l'azienda cambia i tempi nella scheda Messaggi, valgono subito anche per le consegne già proposte.
 * - sollecito: consegna ancora "proposta", nessun sollecito inviato, passate reminderHours dalla proposta
 *   (e non ancora scaduta);
 * - senza risposta: "proposta" da noResponseHours, oppure "da riprogrammare" (ha detto No) da
 *   noResponseHours senza scegliere la data.
 */
export async function dueTimers(db: Db, tenantId: string, tm: TimingSetting) {
  const remind = tm.reminderHours > 0
    ? (await db.query<{ id: string }>(
        `SELECT id FROM deliveries
          WHERE tenant_id = $1 AND status = 'proposed' AND reminders_sent = 0
            AND created_at + make_interval(hours => $2) <= now()
            AND created_at + make_interval(hours => $3) > now()`,
        [tenantId, tm.reminderHours, tm.noResponseHours],
      )).rows.map((r) => r.id)
    : [];
  const expire = (await db.query<{ id: string }>(
    `SELECT d.id FROM deliveries d
      WHERE d.tenant_id = $1 AND (
        (d.status = 'proposed' AND d.created_at + make_interval(hours => $2) <= now())
        OR (d.status = 'to_reschedule' AND COALESCE(
              (SELECT max(e.created_at) FROM delivery_events e WHERE e.delivery_id = d.id AND e.to_status = 'to_reschedule'),
              d.updated_at) + make_interval(hours => $2) <= now())
      )`,
    [tenantId, tm.noResponseHours],
  )).rows.map((r) => r.id);
  return { remind, expire };
}

/** Il sollecito è ancora dovuto con i tempi attuali? (serve per i lavori messi in coda prima di un cambio) */
export async function reminderStillDue(db: Db, id: string, tm: TimingSetting) {
  if (tm.reminderHours <= 0) return false;
  const r = await db.query(
    `SELECT 1 FROM deliveries WHERE id = $1 AND status = 'proposed' AND reminders_sent = 0
       AND created_at + make_interval(hours => $2) <= now() AND created_at + make_interval(hours => $3) > now()`,
    [id, tm.reminderHours, tm.noResponseHours],
  );
  return r.rowCount === 1;
}

/** Prenota il sollecito (una sola volta per consegna, anche con più controlli in parallelo). */
export async function claimReminder(db: Db, id: string) {
  const r = await db.query(
    `UPDATE deliveries SET reminders_sent = reminders_sent + 1 WHERE id = $1 AND status = 'proposed' AND reminders_sent = 0`,
    [id],
  );
  return r.rowCount === 1;
}

/** Invio del sollecito non riuscito: lo rende di nuovo disponibile per il ritentativo. */
export async function releaseReminder(db: Db, id: string) {
  await db.query('UPDATE deliveries SET reminders_sent = 0 WHERE id = $1 AND reminders_sent = 1', [id]);
}

/** Conto alla rovescia per la scheda Messaggi: quando partirà il sollecito e quando la consegna diventerà "Senza risposta". */
export async function listTimers(db: Db, tenantId: string, tm: TimingSetting) {
  const r = await db.query<{
    id: string; order_ref: string | null; customer_name: string; status: string;
    reminder_at: string | null; reminder_sent: boolean; expire_at: string;
  }>(
    `WITH base AS (
       SELECT d.id, d.order_ref, c.name AS customer_name, d.status::text AS status, d.reminders_sent, d.created_at,
              CASE WHEN d.status = 'to_reschedule' THEN COALESCE(
                (SELECT max(e.created_at) FROM delivery_events e WHERE e.delivery_id = d.id AND e.to_status = 'to_reschedule'),
                d.updated_at) ELSE d.created_at END AS since
         FROM deliveries d JOIN customers c ON c.id = d.customer_id
        WHERE d.tenant_id = $1 AND d.status IN ('proposed', 'to_reschedule'))
     SELECT id, order_ref, customer_name, status,
            CASE WHEN status = 'proposed' AND $2 > 0 THEN created_at + make_interval(hours => $2) END AS reminder_at,
            reminders_sent > 0 AS reminder_sent,
            since + make_interval(hours => $3) AS expire_at
       FROM base ORDER BY expire_at LIMIT 200`,
    [tenantId, tm.reminderHours, tm.noResponseHours],
  );
  return r.rows;
}
