import type { Db } from '../lib/db.js';
import { config } from '../config.js';

/* ---------- testi dei messaggi ---------- */

export const MESSAGE_DEFAULTS = {
  wa_proposal: 'Ciao {nome}, sono Vorwerk Consegne. Il tuo {prodotto} (ordine {ordine}) arriverà {data} tra le {inizio} e le {fine}.\nSarai a casa?',
  wa_yes: 'Sì',
  wa_no: 'No',
  wa_confirmed: 'Perfetto, consegna confermata. Ti mandiamo un promemoria il giorno prima.',
  wa_declined: 'Nessun problema. Scegli giorno e fascia oraria che preferisci:\n{link}',
  wa_rescheduled: 'Fatto: la nuova consegna è {data}, {fascia}. A presto!',
  wa_out_area: 'Grazie per averci avvisato. Per il tuo indirizzo la nuova data va concordata con un nostro operatore: ti contatteremo a breve.',
  mail_subject: 'La tua consegna Vorwerk {ordine}',
  mail_body: 'Ciao {nome}, il tuo {prodotto} (ordine {ordine}) arriverà a {indirizzo}.',
  mail_question: 'Sarai a casa?',
  mail_yes: 'Sì, confermo',
  mail_no: 'No, cambia data',
  mail_confirmed: 'Consegna confermata per {data}, {fascia}.\nRiceverai un promemoria il giorno prima.',
  mail_reschedule: 'Scegli quando ricevere il pacco',
  mail_rescheduled: 'Nuova consegna: {data}, {fascia}.',
  mail_out_area: 'Grazie per averci avvisato.\nPer il tuo indirizzo ({indirizzo}) la nuova data va concordata con un nostro operatore: ti contatteremo a breve.',
  page_title: 'Quando vuoi ricevere il pacco?',
  page_note: 'Ordine {ordine} · {indirizzo}. Vedi solo le fasce con posti liberi, aggiornate in tempo reale.',
  page_button: 'Conferma {data}, {fascia}',
};
export type MessageKey = keyof typeof MESSAGE_DEFAULTS;
export type Messages = Record<MessageKey, string>;
export const MESSAGE_VARS = ['nome', 'prodotto', 'ordine', 'data', 'inizio', 'fine', 'fascia', 'indirizzo', 'link'] as const;

/** Sostituisce i campi {nome}, {data}, ... Lascia intatti quelli sconosciuti. */
export function fillText(template: string, vars: Partial<Record<(typeof MESSAGE_VARS)[number], string>>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k as keyof typeof vars] ?? '') : m));
}

/** Stessi controlli del pannello: nessun testo vuoto, solo campi noti, {link} dove serve. */
export function validateMessages(m: Record<string, unknown>): string | null {
  for (const k of Object.keys(MESSAGE_DEFAULTS) as MessageKey[]) {
    const v = m[k];
    if (typeof v !== 'string' || !v.trim()) return `Il testo "${k}" non può essere vuoto.`;
    const unknown = [...v.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]).filter((x) => !(MESSAGE_VARS as readonly string[]).includes(x ?? ''));
    if (unknown.length) return `Campo non riconosciuto in "${k}": {${unknown[0]}}.`;
    if ((k === 'wa_yes' || k === 'wa_no') && v.length > 20) return 'I pulsanti WhatsApp hanno al massimo 20 caratteri.';
  }
  if (!String(m.wa_declined).includes('{link}')) return 'La risposta dopo il rifiuto deve contenere {link}.';
  return null;
}

/* ---------- area servita ---------- */

export interface AreaSetting { on: boolean; list: string }
export const AREA_DEFAULT: AreaSetting = { on: false, list: '' };

export function parseArea(text: string) {
  const rules: { a: string; b: string }[] = [], bad: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const t = raw.trim().replace(/\s*-\s*/, '-');
    if (!t) continue;
    let m: RegExpExecArray | null;
    if (/^\d{5}$/.test(t)) rules.push({ a: t, b: t });
    else if ((m = /^(\d{5})-(\d{5})$/.exec(t)) && m[1]! <= m[2]!) rules.push({ a: m[1]!, b: m[2]! });
    else if ((m = /^(\d{1,4})\*$/.exec(t))) rules.push({ a: m[1]!.padEnd(5, '0'), b: m[1]!.padEnd(5, '9') });
    else bad.push(raw.trim());
  }
  return { rules, bad };
}

/** Area spenta o senza regole: tutti dentro. CAP mancante con area attiva: fuori (decide l'operatore). */
export function inArea(area: AreaSetting, cap: string | null | undefined): boolean {
  if (!area.on) return true;
  const { rules } = parseArea(area.list);
  if (!rules.length) return true;
  return /^\d{5}$/.test(cap ?? '') && rules.some((r) => cap! >= r.a && cap! <= r.b);
}

/* ---------- finestra di prenotazione ---------- */

export interface BookingSetting { horizon: number; lead: number }

/* ---------- accesso (per ambiente) ---------- */

async function get<T>(db: Db, tenantId: string, key: string, fallback: T): Promise<T> {
  const r = await db.query<{ value: T }>('SELECT value FROM settings WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
  return r.rows[0] ? { ...fallback, ...r.rows[0].value } : fallback;
}
async function put(db: Db, tenantId: string, key: string, value: unknown) {
  await db.query(
    `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, key, JSON.stringify(value)],
  );
}

export const getMessages = (db: Db, t: string) => get<Messages>(db, t, 'messages', { ...MESSAGE_DEFAULTS });
export const saveMessages = (db: Db, t: string, m: Messages) => put(db, t, 'messages', m);
export const getArea = (db: Db, t: string) => get<AreaSetting>(db, t, 'area', { ...AREA_DEFAULT });
export const saveArea = (db: Db, t: string, a: AreaSetting) => put(db, t, 'area', a);
export const getBooking = (db: Db, t: string) =>
  get<BookingSetting>(db, t, 'booking', { horizon: config.BOOKING_HORIZON_DAYS, lead: config.BOOKING_LEAD_DAYS });
export const saveBooking = (db: Db, t: string, b: BookingSetting) => put(db, t, 'booking', b);
