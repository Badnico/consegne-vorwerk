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
  answer: string | null; body: string; payload: unknown; waName?: string | null;
}) {
  const phone = '+' + args.fromDigits.replace(/\D/g, '');
  const o = await ownerOf(db, args.deliveryId, phone, args.phoneNumberId);
  const r = await db.query(
    `INSERT INTO late_replies (tenant_id, delivery_id, provider_id, from_phone, answer, body, payload, wa_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (provider_id) DO NOTHING`,
    [o.tenantId, o.deliveryId, args.providerId, phone, args.answer, args.body, JSON.stringify(args.payload), args.waName?.trim().slice(0, 120) || null],
  );
  return (r.rowCount ?? 0) > 0;
}

const ANSWER_LABEL: Record<string, string> = {
  YES: 'Sì alla consegna', NO: 'No alla consegna', PINYES: 'Sì, ha il PIN', PINNO: 'No, non ha il PIN',
};

export async function listLateReplies(db: Db, tenantId: string) {
  // nome: dalla consegna eliminata, poi da un file Excel caricato, poi dall'anagrafica clienti, infine dal profilo WhatsApp
  const r = await db.query<{
    id: string; created_at: string; seen_at: string | null; from_phone: string; answer: string | null; body: string;
    customer_name: string | null; order_ref: string | null; address: string | null; import_file: string | null; wa_name: string | null;
  }>(
    `SELECT l.id, l.created_at, l.seen_at, l.from_phone, l.answer, l.body, l.wa_name,
            coalesce(dd.customer_name, n.name, c.name) AS customer_name,
            coalesce(dd.order_ref, n.order_ref) AS order_ref,
            coalesce(dd.address, n.address) AS address,
            coalesce(dd.import_file, n.source_file) AS import_file
       FROM late_replies l
       LEFT JOIN LATERAL (
         SELECT * FROM deleted_deliveries x
          WHERE x.tenant_id = l.tenant_id AND (x.id = l.delivery_id OR x.phone_e164 = l.from_phone)
          ORDER BY (x.id = l.delivery_id) DESC, x.deleted_at DESC LIMIT 1) dd ON true
       LEFT JOIN late_reply_names n ON n.tenant_id = l.tenant_id AND n.phone_e164 = l.from_phone
       LEFT JOIN LATERAL (SELECT name FROM customers y WHERE y.tenant_id = l.tenant_id AND y.phone_e164 = l.from_phone LIMIT 1) c ON true
      WHERE l.tenant_id = $1 AND l.created_at > now() - make_interval(days => $2)
      ORDER BY l.created_at DESC LIMIT 200`,
    [tenantId, LATE_REPLY_DAYS],
  );
  return r.rows.map((x) => ({
    id: x.id, at: x.created_at, seen: Boolean(x.seen_at), phone: x.from_phone,
    answer: x.answer ? ANSWER_LABEL[x.answer] ?? x.answer : null, text: x.body,
    name: x.customer_name, waName: x.wa_name, order: x.order_ref, address: x.address, file: x.import_file,
  }));
}

/**
 * Riconosce i nomi da un file Excel dell'azienda (il file delle consegne caricato o un report scaricato):
 * per ogni numero che ha scritto, salva nome, ordine e indirizzo trovati nel file. Torna quanti numeri sono stati riconosciuti.
 */
export async function namesFromRows(db: Db, tenantId: string, fileName: string,
  rows: { phone: string; name: string; order_ref: string; address: string; city: string; province: string }[]) {
  const waiting = new Set((await db.query<{ from_phone: string }>(
    `SELECT DISTINCT from_phone FROM late_replies WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`,
    [tenantId, LATE_REPLY_DAYS])).rows.map((x) => x.from_phone));
  const found = new Set<string>();
  for (const r of rows) {
    if (!r.phone || !r.name || !waiting.has(r.phone) || found.has(r.phone)) continue;
    // l'indirizzo letto dal file contiene già comune e provincia
    const addr = r.address || [r.city, r.province && `(${r.province})`].filter(Boolean).join(' ');
    await db.query(
      `INSERT INTO late_reply_names (tenant_id, phone_e164, name, order_ref, address, source_file) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET name = EXCLUDED.name, order_ref = EXCLUDED.order_ref,
         address = EXCLUDED.address, source_file = EXCLUDED.source_file, created_at = now()`,
      [tenantId, r.phone, r.name.slice(0, 200), r.order_ref || null, addr.slice(0, 300) || null, fileName.slice(0, 200) || null],
    );
    found.add(r.phone);
  }
  return { found: found.size, waiting: waiting.size };
}

/** Elimina tutti i messaggi di un cliente (numero di telefono) dal riquadro, insieme al nome abbinato. */
export async function deleteLateReplies(db: Db, tenantId: string, phone: string) {
  const r = await db.query('DELETE FROM late_replies WHERE tenant_id = $1 AND from_phone = $2', [tenantId, phone]);
  await db.query('DELETE FROM late_reply_names WHERE tenant_id = $1 AND phone_e164 = $2', [tenantId, phone]);
  return r.rowCount ?? 0;
}

export async function markLateRepliesSeen(db: Db, tenantId: string) {
  await db.query('UPDATE late_replies SET seen_at = now() WHERE tenant_id = $1 AND seen_at IS NULL', [tenantId]);
}

/**
 * La consegna è "Senza risposta"? Da quel momento le risposte del cliente (WhatsApp o pagina web) non si accettano più:
 * riceve il testo "late_answer" e lo richiama un operatore. Vale per tutte le aziende.
 */
export async function lateLocked(db: Db, deliveryId: string) {
  const r = await db.query<{ locked: boolean }>(
    `SELECT d.status = 'no_response' AS locked FROM deliveries d WHERE d.id = $1`,
    [deliveryId],
  );
  return r.rows[0]?.locked ?? false;
}
