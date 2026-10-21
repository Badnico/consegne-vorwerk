import type { Db } from '../lib/db.js';
import { config } from '../config.js';

/* ---------- testi dei messaggi ---------- */

export const MESSAGE_DEFAULTS = {
  wa_proposal: 'Ciao {nome}, ti scriviamo per conto di {azienda}. Il tuo {prodotto} (ordine {ordine}) arriverà {data} tra le {inizio} e le {fine}.\nSarai a casa?',
  wa_yes: 'Sì',
  wa_no: 'No',
  wa_confirmed: 'Perfetto, consegna confermata.',
  wa_declined: 'Nessun problema. Scegli giorno e fascia oraria che preferisci:\n{link}',
  wa_rescheduled: 'Fatto: la nuova consegna è {data}, {fascia}. A presto!',
  wa_out_area: 'Grazie per averci avvisato. Per il tuo indirizzo la nuova data va concordata con un nostro operatore: ti contatteremo a breve.',
  mail_subject: '{azienda}: la tua consegna {ordine}',
  mail_body: 'Ciao {nome}, il tuo {prodotto} (ordine {ordine}) arriverà a {indirizzo}.',
  mail_question: 'Sarai a casa?',
  mail_yes: 'Sì, confermo',
  mail_no: 'No, cambia data',
  mail_confirmed: 'Consegna confermata per {data}, {fascia}.',
  mail_reschedule: 'Scegli quando ricevere il pacco',
  mail_rescheduled: 'Nuova consegna: {data}, {fascia}.',
  mail_out_area: 'Grazie per averci avvisato.\nPer il tuo indirizzo ({indirizzo}) la nuova data va concordata con un nostro operatore: ti contatteremo a breve.',
  page_title: 'Quando vuoi ricevere il pacco?',
  page_note: 'Ordine {ordine} · {indirizzo}. Vedi solo le fasce con posti liberi, aggiornate in tempo reale.',
  page_button: 'Conferma {data}, {fascia}',
  wa_pin_question: 'Hai ricevuto il PIN?',
  wa_pin_yes: 'Sì',
  wa_pin_no: 'No',
  wa_pin_missing: 'Grazie per averci avvisato. Senza il PIN non possiamo completare la consegna: un nostro operatore ti contatterà a breve.',
  mail_pin_missing: "Grazie per averci avvisato.\nSenza il PIN non possiamo completare la consegna dell'ordine {ordine}: un nostro operatore ti contatterà a breve.",
  extra_address: 'Indirizzo di consegna: {indirizzo}',
  extra_cod: "Ricorda che c'è il contrassegno da pagare di {contrassegno}.",
  extra_pickup: 'Ricorda di preparare al corriere il prodotto da ritirare.',
};
export type MessageKey = keyof typeof MESSAGE_DEFAULTS;
export type Messages = Record<MessageKey, string>;
export const MESSAGE_VARS = ['azienda', 'contrassegno', 'nome', 'prodotto', 'ordine', 'data', 'inizio', 'fine', 'fascia', 'indirizzo', 'link'] as const;

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
    if (['wa_yes', 'wa_no', 'wa_pin_yes', 'wa_pin_no'].includes(k) && v.length > 20) return 'I pulsanti WhatsApp hanno al massimo 20 caratteri.';
  }
  if (!String(m.wa_declined).includes('{link}')) return 'La risposta dopo il rifiuto deve contenere {link}.';
  return null;
}

/* ---------- area servita ---------- */

/** callAll: "Se clicca NO va richiamato": chi risponde No riceve sempre il messaggio "fuori area" e lo richiama un operatore. */
/** noSend: CAP, località o sigle di provincia a cui NON mandare il primo messaggio (la consegna passa subito all'operatore). */
export interface AreaSetting { on: boolean; list: string; callAll?: boolean; noSend?: string }
export const AREA_DEFAULT: AreaSetting = { on: false, list: '', callAll: false, noSend: '' };

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

/** Può scegliere da solo la nuova data? No se l'operatore deve richiamare tutti o se il CAP è fuori area. */
export function canSelfBook(area: AreaSetting, cap: string | null | undefined): boolean {
  return !area.callAll && inArea(area, cap);
}

const normPlace = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Sigle e nomi delle province italiane: per escludere scrivendo "LECCE" anche se il file ha solo la sigla "LE". */
export const PROVINCE: Record<string, string> = {
  AG: 'Agrigento', AL: 'Alessandria', AN: 'Ancona', AO: 'Aosta', AP: 'Ascoli Piceno', AQ: "L'Aquila", AR: 'Arezzo', AT: 'Asti',
  AV: 'Avellino', BA: 'Bari', BG: 'Bergamo', BI: 'Biella', BL: 'Belluno', BN: 'Benevento', BO: 'Bologna', BR: 'Brindisi',
  BS: 'Brescia', BT: 'Barletta-Andria-Trani', BZ: 'Bolzano', CA: 'Cagliari', CB: 'Campobasso', CE: 'Caserta', CH: 'Chieti',
  CL: 'Caltanissetta', CN: 'Cuneo', CO: 'Como', CR: 'Cremona', CS: 'Cosenza', CT: 'Catania', CZ: 'Catanzaro', EN: 'Enna',
  FC: 'Forlì-Cesena', FE: 'Ferrara', FG: 'Foggia', FI: 'Firenze', FM: 'Fermo', FR: 'Frosinone', GE: 'Genova', GO: 'Gorizia',
  GR: 'Grosseto', IM: 'Imperia', IS: 'Isernia', KR: 'Crotone', LC: 'Lecco', LE: 'Lecce', LI: 'Livorno', LO: 'Lodi', LT: 'Latina',
  LU: 'Lucca', MB: 'Monza e Brianza', MC: 'Macerata', ME: 'Messina', MI: 'Milano', MN: 'Mantova', MO: 'Modena', MS: 'Massa-Carrara',
  MT: 'Matera', NA: 'Napoli', NO: 'Novara', NU: 'Nuoro', OR: 'Oristano', PA: 'Palermo', PC: 'Piacenza', PD: 'Padova', PE: 'Pescara',
  PG: 'Perugia', PI: 'Pisa', PN: 'Pordenone', PO: 'Prato', PR: 'Parma', PT: 'Pistoia', PU: 'Pesaro e Urbino', PV: 'Pavia',
  PZ: 'Potenza', RA: 'Ravenna', RC: 'Reggio Calabria', RE: 'Reggio Emilia', RG: 'Ragusa', RI: 'Rieti', RM: 'Roma', RN: 'Rimini',
  RO: 'Rovigo', SA: 'Salerno', SI: 'Siena', SO: 'Sondrio', SP: 'La Spezia', SR: 'Siracusa', SS: 'Sassari', SU: 'Sud Sardegna',
  SV: 'Savona', TA: 'Taranto', TE: 'Teramo', TN: 'Trento', TO: 'Torino', TP: 'Trapani', TR: 'Terni', TS: 'Trieste', TV: 'Treviso',
  UD: 'Udine', VA: 'Varese', VB: 'Verbano-Cusio-Ossola', VC: 'Vercelli', VE: 'Venezia', VI: 'Vicenza', VR: 'Verona', VT: 'Viterbo',
  VV: 'Vibo Valentia',
};

/**
 * Esclusione dal primo messaggio: righe/virgole con CAP (20121, 20121-20162, 201*), nomi di località (ANDRANO),
 * sigle di provincia (LE) o nomi di provincia (LECCE). Restituisce la voce che corrisponde, oppure null.
 */
export function noSendMatch(list: string | undefined, d: { cap?: string | null; city?: string | null; province?: string | null }): string | null {
  if (!list?.trim()) return null;
  const city = normPlace(d.city ?? ''), prov = normPlace(d.province ?? '');
  const provName = normPlace(PROVINCE[prov] ?? ''); // "LE" → "LECCE"
  for (const raw of list.split(/[\n,;]+/)) {
    const t = raw.trim(); if (!t) continue;
    const { rules } = parseArea(t);
    if (rules.length) { if (/^\d{5}$/.test(d.cap ?? '') && rules.some((r) => d.cap! >= r.a && d.cap! <= r.b)) return t; continue; }
    const n = normPlace(t);
    if (n && (n === city || n === prov || n === provName)) return t;
  }
  return null;
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

/* ---------- report Excel periodico ---------- */

/**
 * hours: ogni quante ore generare il report (0 = spento). email: mandarlo anche per email. to: destinatario (vuoto = email dell'ambiente).
 * at: "HH:MM" = ogni giorno a quell'ora (vuoto = spento). Solo per gli ambienti con la funzione extra "reportAtTime".
 */
export interface ReportSetting { hours: number; email: boolean; to: string; at: string }
export const REPORT_DEFAULT: ReportSetting = { hours: 0, email: true, to: '', at: '' };

/* ---------- funzioni extra per ambiente (si attivano dal pannello amministratore) ---------- */

export interface Features { reportAtTime?: boolean; neutralExamples?: boolean }
export const FEATURE_LABELS: Record<keyof Features, string> = { reportAtTime: 'Report Excel a orario fisso', neutralExamples: 'Esempi senza marchi' };
/** Prodotto usato negli esempi del portale: generico per le aziende con "Esempi senza marchi", altrimenti quello di sempre. */
export const exampleProduct = (f: Features, usual: string) => (f.neutralExamples ? 'Robot da cucina' : usual);
export async function getFeatures(db: Db, tenantId: string): Promise<Features> {
  return (await db.query<{ features: Features }>('SELECT features FROM tenants WHERE id = $1', [tenantId])).rows[0]?.features ?? {};
}
export const getReportSetting = (db: Db, t: string) => get<ReportSetting>(db, t, 'report', { ...REPORT_DEFAULT });
export const saveReportSetting = (db: Db, t: string, r: ReportSetting) => put(db, t, 'report', r);

/** Quando sono stati fatti gli ultimi report automatici: resta anche dopo che i file sono stati cancellati. */
export interface ReportState { lastAuto?: string; lastTimeDay?: string; lastTimeAt?: string }
export const getReportState = (db: Db, t: string) => get<ReportState>(db, t, 'report_state', {});
export const saveReportState = async (db: Db, t: string, patch: ReportState) => put(db, t, 'report_state', { ...(await getReportState(db, t)), ...patch });

/** Percorso dei messaggi. askPin: dopo il Sì chiede "Hai ricevuto il PIN?" prima di confermare. */
export interface FlowSetting { askPin: boolean }
export const getFlow = (db: Db, t: string) => get<FlowSetting>(db, t, 'flow', { askPin: true });

/* ---------- tempi di sollecito e "senza risposta" (per azienda) ---------- */
export interface TimingSetting { reminderHours: number; noResponseHours: number } // reminderHours 0 = nessun sollecito
export const timingDefault = (): TimingSetting => ({ reminderHours: config.REMINDER_AFTER_HOURS, noResponseHours: config.NO_RESPONSE_AFTER_HOURS });
export const getTiming = async (db: Db, t: string) => ({ ...timingDefault(), ...(await get<Partial<TimingSetting>>(db, t, 'timing', {})) });
export const saveTiming = (db: Db, t: string, v: TimingSetting) => put(db, t, 'timing', v);
export const saveFlow = (db: Db, t: string, f: FlowSetting) => put(db, t, 'flow', f);

/**
 * Numero WhatsApp del cliente (facoltativo). Vuoto = i messaggi partono dal numero generale impostato su Render.
 * token e appSecret servono solo se il numero è su un account Meta diverso dal tuo.
 */
export interface WaSetting { phoneNumberId: string; token: string; appSecret: string; template: string; lang: string; waba?: string }
export const WA_DEFAULT: WaSetting = { phoneNumberId: '', token: '', appSecret: '', template: '', lang: '', waba: '' };
export const getWaSetting = async (db: Db, t: string) => ({ ...WA_DEFAULT, ...(await get<Partial<WaSetting>>(db, t, 'whatsapp', {})) });

/**
 * Modello WhatsApp personalizzato della proposta (per azienda): il testo della scheda Messaggi
 * mandato a Meta per l'approvazione. Finché non è approvato si usa il modello standard.
 */
export interface WaTemplateSetting {
  name: string; id: string; text: string; vars: string[]; waba: string;
  status: string; reason: string; category: string; submittedAt: string; checkedAt: string;
}
export async function getWaTemplate(db: Db, t: string): Promise<WaTemplateSetting | null> {
  const v = await get<Partial<WaTemplateSetting>>(db, t, 'wa_template', {});
  return v && v.name ? (v as WaTemplateSetting) : null; // null = nessun modello personalizzato
}
export const saveWaTemplate = (db: Db, t: string, v: WaTemplateSetting | null) => put(db, t, 'wa_template', v);
export const saveWaSetting = (db: Db, t: string, w: WaSetting) => put(db, t, 'whatsapp', w);
/** Ambienti che hanno impostato questo numero (per il webhook). */
export async function tenantsByPhoneNumberId(db: Db, phoneNumberId: string) {
  const r = await db.query<{ tenant_id: string; value: WaSetting }>(
    "SELECT tenant_id, value FROM settings WHERE key = 'whatsapp' AND value->>'phoneNumberId' = $1", [phoneNumberId]);
  return r.rows;
}

