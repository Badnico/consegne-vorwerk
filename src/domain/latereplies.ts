import type { Db } from '../lib/db.js';

/**
 * Risposte arrivate su WhatsApp per consegne già eliminate (es. dopo "Elimina tutte").
 * Non cambiano nulla nelle consegne: si salvano e si mostrano all'azienda, che richiama il cliente.
 */

export const LATE_REPLY_DAYS = 30;

/** Al momento dell'eliminazione si conservano i dati per riconoscere le risposte che arriveranno dopo. */
export async function rememberDeleted(db: Db, deliveryId: string) {
  await db.query(
    `INSERT INTO deleted_deliveries (id, tenant_id, order_ref, customer_name, phone_e164, address, product, import_file, status)
     SELECT d.id, d.tenant_id, d.order_ref, c.name, c.phone_e164, d.address, d.product, d.import_file, d.status::text
       FROM deliveries d JOIN customers c ON c.id = d.customer_id WHERE d.id = $1
     ON CONFLICT (id) DO NOTHING`,
    [deliveryId],
  );
}

export async function deliveryExists(db: Db, id: string) {
  return ((await db.query('SELECT 1 FROM deliveries WHERE id = $1', [id])).rowCount ?? 0) > 0;
}

/**
 * A quale azienda appartiene una risposta senza consegna: dalla consegna eliminata (per id o per numero del cliente);
 * altrimenti dall'unica azienda che usa quel numero WhatsApp o, se sono più d'una, da quella che ha scritto per ultima.
 */
async function ownerOf(db: Db, deliveryId: string | null, phone: string, phoneNumberId: string | undefined) {
  const del = await db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM deleted_deliveries WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
        OR ($1::uuid IS NULL AND phone_e164 = $2)
      ORDER BY (id = $1::uuid) DESC NULLS LAST, deleted_at DESC LIMIT 1`,
    [deliveryId, phone],
  );
  if (del.rows[0]) return { tenantId: del.rows[0].tenant_id, deliveryId: deliveryId ?? del.rows[0].id };
  const t = await db.query<{ tenant_id: string }>(
    `SELECT s.tenant_id FROM settings s
      WHERE s.key = 'whatsapp' AND coalesce(s.value->>'phoneNumberId', '') <> '' AND s.value->>'phoneNumberId' = $1
      ORDER BY (SELECT max(m.created_at) FROM messages m JOIN deliveries d ON d.id = m.delivery_id
                 WHERE d.tenant_id = s.tenant_id AND m.direction = 'out') DESC NULLS LAST
      LIMIT 1`,
    [phoneNumberId ?? ''],
  );
  return { tenantId: t.rows[0]?.tenant_id ?? null, deliveryId };
}

/** Salva la risposta; false se già registrata (Meta può mandare lo stesso evento più volte). */
export async function recordLateReply(db: Db, args: {
  deliveryId: string | null; providerId: string; fromDigits: string; phoneNumberId: string | undefined;
  answer: string | null; body: string; payload: unknown;
}) {
  const phone = '+' + args.fromDigits.replace(/\D/g, '');
  const o = await ownerOf(db, args.deliveryId, phone, args.phoneNumberId);
  const r = await db.query(
    `INSERT INTO late_replies (tenant_id, delivery_id, provider_id, from_phone, answer, body, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider_id) DO NOTHING`,
    [o.tenantId, o.deliveryId, args.providerId, phone, args.answer, args.body, JSON.stringify(args.payload)],
  );
  return (r.rowCount ?? 0) > 0;
}

const ANSWER_LABEL: Record<string, string> = {
  YES: 'Sì alla consegna', NO: 'No alla consegna', PINYES: 'Sì, ha il PIN', PINNO: 'No, non ha il PIN',
};

export async function listLateReplies(db: Db, tenantId: string) {
  const r = await db.query<{
    id: string; created_at: string; seen_at: string | null; from_phone: string; answer: string | null; body: string;
    customer_name: string | null; order_ref: string | null; address: string | null; import_file: string | null;
  }>(
    `SELECT l.id, l.created_at, l.seen_at, l.from_phone, l.answer, l.body,
            dd.customer_name, dd.order_ref, dd.address, dd.import_file
       FROM late_replies l
       LEFT JOIN LATERAL (
         SELECT * FROM deleted_deliveries x
          WHERE x.tenant_id = l.tenant_id AND (x.id = l.delivery_id OR (l.delivery_id IS NULL AND x.phone_e164 = l.from_phone))
          ORDER BY (x.id = l.delivery_id) DESC, x.deleted_at DESC LIMIT 1) dd ON true
      WHERE l.tenant_id = $1 AND l.created_at > now() - make_interval(days => $2)
      ORDER BY l.created_at DESC LIMIT 200`,
    [tenantId, LATE_REPLY_DAYS],
  );
  return r.rows.map((x) => ({
    id: x.id, at: x.created_at, seen: Boolean(x.seen_at), phone: x.from_phone,
    answer: x.answer ? ANSWER_LABEL[x.answer] ?? x.answer : null, text: x.body,
    name: x.customer_name, order: x.order_ref, address: x.address, file: x.import_file,
  }));
}

export async function markLateRepliesSeen(db: Db, tenantId: string) {
  await db.query('UPDATE late_replies SET seen_at = now() WHERE tenant_id = $1 AND seen_at IS NULL', [tenantId]);
}

/** La consegna è "Senza risposta" e l'azienda ha scelto di non accettare più le risposte? */
export async function lateLocked(db: Db, deliveryId: string) {
  const r = await db.query<{ locked: boolean }>(
    `SELECT d.status = 'no_response' AND coalesce((s.value->>'lateLock')::boolean, false) AS locked
       FROM deliveries d LEFT JOIN settings s ON s.tenant_id = d.tenant_id AND s.key = 'flow' WHERE d.id = $1`,
    [deliveryId],
  );
  return r.rows[0]?.locked ?? false;
}
