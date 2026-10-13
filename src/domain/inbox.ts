import type { Db } from '../lib/db.js';

/**
 * Messaggi scritti dai clienti su WhatsApp e risposte dell'operatore dal pannello.
 * I messaggi in entrata senza pulsante (testo, foto, vocali) si collegano alla consegna dal numero di telefono.
 */

export const FREE_WINDOW_HOURS = 24; // WhatsApp: risposte libere (e gratuite) entro 24 ore dall'ultimo messaggio del cliente

/** Testo leggibile di un messaggio in entrata di Meta. */
export function inboundText(msg: {
  type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } };
  image?: { caption?: string }; document?: { filename?: string };
}): string {
  if (msg.text?.body) return msg.text.body;
  if (msg.button?.text) return msg.button.text;
  if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
  switch (msg.type) {
    case 'image': return `[foto]${msg.image?.caption ? ' ' + msg.image.caption : ''}`;
    case 'audio': return '[messaggio vocale]';
    case 'video': return '[video]';
    case 'document': return `[documento${msg.document?.filename ? ': ' + msg.document.filename : ''}]`;
    case 'location': return '[posizione]';
    case 'sticker': return '[sticker]';
    default: return `[${msg.type ?? 'messaggio'}]`;
  }
}

/**
 * Consegna a cui appartiene un messaggio arrivato dal numero `fromDigits` sul numero WhatsApp `phoneNumberId`.
 * Se il numero è di un cliente cerca solo nei suoi ambienti, altrimenti negli ambienti che usano il numero generale.
 * Preferisce le consegne aperte e le più recenti.
 */
export async function findDeliveryForPhone(db: Db, fromDigits: string, phoneNumberId: string | undefined): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `WITH own AS (
       SELECT tenant_id FROM settings WHERE key = 'whatsapp' AND coalesce(value->>'phoneNumberId', '') <> '' AND value->>'phoneNumberId' = $2
     ), others AS (
       SELECT tenant_id FROM settings WHERE key = 'whatsapp' AND coalesce(value->>'phoneNumberId', '') <> '' AND value->>'phoneNumberId' <> $2
     )
     SELECT d.id FROM deliveries d JOIN customers c ON c.id = d.customer_id
      WHERE c.phone_e164 = $1
        AND (CASE WHEN EXISTS (SELECT 1 FROM own) THEN d.tenant_id IN (SELECT tenant_id FROM own)
                  ELSE d.tenant_id NOT IN (SELECT tenant_id FROM others) END)
      ORDER BY (d.status NOT IN ('delivered', 'cancelled')) DESC, d.created_at DESC
      LIMIT 1`,
    ['+' + fromDigits.replace(/\D/g, ''), phoneNumberId ?? ''],
  );
  return r.rows[0]?.id ?? null;
}

/** Non letti e ultimo messaggio del cliente per ogni consegna (per la lista del pannello). */
export async function inboxSummary(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { unread: number; lastIn: string | null }>();
  const r = await db.query<{ delivery_id: string; unread: number; last_in: string | null }>(
    `SELECT delivery_id,
            count(*) FILTER (WHERE direction = 'in' AND kind = 'text' AND read_at IS NULL)::int AS unread,
            max(created_at) FILTER (WHERE direction = 'in') AS last_in
       FROM messages WHERE delivery_id = ANY($1::uuid[]) GROUP BY delivery_id`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.delivery_id, { unread: x.unread, lastIn: x.last_in }]));
}

const OUT_LABEL: Record<string, string> = {
  proposal: 'Proposta di consegna', reminder: 'Sollecito', reschedule_link: 'Link per scegliere la data', confirmation: 'Conferma',
  out_of_area: 'Messaggio fuori area', pin_question: 'Domanda sul PIN',
};

/** Conversazione di una consegna, dal più vecchio. */
export async function conversation(db: Db, deliveryId: string) {
  const r = await db.query<{ id: string; direction: 'in' | 'out'; kind: string; channel: string; status: string; body: string | null; created_at: string }>(
    'SELECT id, direction, kind, channel, status, body, created_at FROM messages WHERE delivery_id = $1 ORDER BY created_at, id LIMIT 300',
    [deliveryId],
  );
  return r.rows.map((m) => ({
    id: m.id, dir: m.direction, kind: m.kind, channel: m.channel, status: m.status, at: m.created_at,
    text: m.body ?? (m.direction === 'out' ? `${OUT_LABEL[m.kind] ?? m.kind}${m.channel === 'email' ? ' (email)' : ''}` : ''),
  }));
}

export async function markRead(db: Db, deliveryId: string) {
  await db.query("UPDATE messages SET read_at = now() WHERE delivery_id = $1 AND direction = 'in' AND read_at IS NULL", [deliveryId]);
}

/** Ultimo messaggio del cliente: serve per sapere se si può ancora rispondere liberamente. */
export async function lastInbound(db: Db, deliveryId: string): Promise<Date | null> {
  const r = await db.query<{ at: Date | null }>("SELECT max(created_at) AS at FROM messages WHERE delivery_id = $1 AND direction = 'in'", [deliveryId]);
  return r.rows[0]?.at ? new Date(r.rows[0].at) : null;
}
