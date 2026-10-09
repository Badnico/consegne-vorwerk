import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Db } from '../lib/db.js';
import { addDays, hhmm, todayLocal } from '../lib/dates.js';
import { getBooking } from './settings.js';

/**
 * Importazione delle consegne da un file Excel caricato nel pannello.
 * Le intestazioni delle colonne sono riconosciute in modo tollerante (maiuscole, accenti, sinonimi).
 * Data e fascia sono facoltative: se mancano, il sistema propone la prima fascia libera.
 */

export const MAX_ROWS = 1000;

export interface ImportRow {
  line: number; // riga del foglio Excel
  name: string;
  address: string;
  cap: string;
  phone: string; // formato +39...
  email: string;
  product: string;
  order_ref: string; // vuoto = generato all'invio
  date: string | null; // AAAA-MM-GG chiesta nel file
  band: string | null; // HH:MM chiesta nel file (inizio fascia)
}

export interface PlannedRow extends ImportRow {
  errors: string[];
  slot: { date: string; bandId: string } | null; // fascia che verrà proposta
  auto: boolean; // fascia scelta dal sistema
}

type Field = 'name' | 'surname' | 'address' | 'city' | 'cap' | 'phone' | 'email' | 'product' | 'order_ref' | 'date' | 'band';

const ALIASES: Record<Field, string[]> = {
  name: ['nome', 'cliente', 'nome cliente', 'nominativo', 'nome e cognome', 'nome cognome', 'cognome e nome', 'ragione sociale', 'destinatario'],
  surname: ['cognome'],
  address: ['indirizzo', 'via', 'indirizzo consegna', 'indirizzo di consegna', 'recapito'],
  city: ['citta', 'comune', 'localita', 'paese'],
  cap: ['cap', 'codice postale', 'c a p'],
  phone: ['telefono', 'cellulare', 'whatsapp', 'tel', 'cell', 'numero', 'numero di telefono', 'telefono cellulare', 'mobile'],
  email: ['email', 'e mail', 'mail', 'posta elettronica', 'indirizzo email'],
  product: ['prodotto', 'articolo', 'descrizione', 'modello', 'merce'],
  order_ref: ['ordine', 'n ordine', 'numero ordine', 'nr ordine', 'codice ordine', 'rif', 'riferimento', 'id ordine', 'ordine n'],
  date: ['data', 'data consegna', 'data di consegna', 'data proposta', 'giorno'],
  band: ['fascia', 'fascia oraria', 'orario', 'ora', 'ora consegna', 'orario consegna'],
};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fieldOf = (header: string): Field | null => {
  const h = norm(header);
  if (!h) return null;
  for (const [f, list] of Object.entries(ALIASES) as [Field, string[]][]) if (list.includes(h)) return f;
  return null;
};

/** Valore di una cella come testo, qualunque sia il tipo che Excel ha salvato. */
function cellValue(v: ExcelJS.CellValue): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || v instanceof Date) return v;
  if (typeof v === 'boolean') return v ? 'sì' : 'no';
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return cellValue((v as { text: ExcelJS.CellValue }).text);
  }
  return String(v);
}
const asText = (v: string | number | Date | null) => (v === null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).replace(/\s+/g, ' ').trim();

const pad = (n: number) => String(n).padStart(2, '0');
/** Data Excel (oggetto, numero seriale o testo gg/mm/aaaa) → AAAA-MM-GG */
export function parseDate(v: string | number | Date | null): string | null | 'invalid' {
  if (v === null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? 'invalid' : `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number') {
    if (v < 30000 || v > 80000) return 'invalid';
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s))) [d, mo, y] = [+m[1]!, +m[2]!, m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!];
  else return 'invalid';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return 'invalid';
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Fascia "08:00-11:00", "8-11", "dalle 8.30 alle 11", "8:00" o un orario Excel → inizio "HH:MM" */
export function parseBand(v: string | number | Date | null): string | null | 'invalid' {
  if (v === null || v === '') return null;
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number') {
    if (v > 0 && v < 1) { const min = Math.round(v * 1440); return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
    if (Number.isInteger(v) && v >= 0 && v < 24) return `${pad(v)}:00`;
    return 'invalid';
  }
  const m = /(\d{1,2})(?:[:.](\d{2}))?/.exec(v);
  if (!m || +m[1]! > 23) return 'invalid';
  return `${pad(+m[1]!)}:${m[2] ?? '00'}`;
}

export function normalizePhone(v: string): string | 'invalid' {
  let s = v.replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) s = (s.startsWith('39') && s.length >= 11 ? '+' : '+39') + s;
  return /^\+\d{8,15}$/.test(s) ? s : 'invalid';
}

const emailOk = (s: string) => z.string().email().safeParse(s).success;

/** Legge il primo foglio che ha una riga di intestazione riconoscibile. */
export async function parseWorkbook(buf: Buffer): Promise<{ rows: ImportRow[]; errors: PlannedRow[]; missing: string[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); }
  catch { throw new Error('Il file non è un Excel valido. Salvalo in formato .xlsx e riprova.'); }

  for (const ws of wb.worksheets) {
    // cerca l'intestazione nelle prime 10 righe
    for (let h = 1; h <= Math.min(10, ws.rowCount); h++) {
      const cols = new Map<Field, number>();
      ws.getRow(h).eachCell((cell, col) => {
        const f = fieldOf(asText(cellValue(cell.value)));
        if (f && !cols.has(f)) cols.set(f, col);
      });
      if (cols.size < 2) continue;

      const missing = [
        !cols.has('name') && 'Cliente (o Nome)',
        !cols.has('address') && 'Indirizzo',
        !cols.has('cap') && 'CAP',
        !cols.has('phone') && !cols.has('email') && 'Telefono o Email',
      ].filter(Boolean) as string[];
      if (missing.length) return { rows: [], errors: [], missing };

      const rows: ImportRow[] = [], errors: PlannedRow[] = [];
      for (let r = h + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const raw = (f: Field) => (cols.has(f) ? cellValue(row.getCell(cols.get(f)!).value) : null);
        const txt = (f: Field) => asText(raw(f));
        if (!(Object.keys(ALIASES) as Field[]).some((f) => txt(f))) continue; // riga vuota
        if (rows.length + errors.length >= MAX_ROWS) throw new Error(`Il file ha più di ${MAX_ROWS} consegne: dividilo in più file.`);

        const err: string[] = [];
        const name = [txt('name'), txt('surname')].filter(Boolean).join(' ');
        let address = txt('address');
        const city = txt('city');
        if (city && !norm(address).includes(norm(city))) address = address ? `${address}, ${city}` : city;
        const capRaw = raw('cap');
        const cap = typeof capRaw === 'number' ? String(Math.round(capRaw)).padStart(5, '0') : txt('cap').replace(/\s/g, '');
        const phone = normalizePhone(txt('phone'));
        const email = txt('email').toLowerCase();
        const date = parseDate(raw('date'));
        const band = parseBand(raw('band'));

        if (!name) err.push('manca il nome');
        if (address.length < 3) err.push("manca l'indirizzo");
        if (!/^\d{5}$/.test(cap)) err.push(cap ? `CAP non valido (${cap})` : 'manca il CAP');
        if (phone === 'invalid') err.push(`telefono non valido (${txt('phone')})`);
        if (email && !emailOk(email)) err.push(`email non valida (${email})`);
        if (!(phone && phone !== 'invalid') && !(email && emailOk(email))) if (!err.some((e) => e.startsWith('telefono') || e.startsWith('email'))) err.push('serve almeno telefono o email');
        if (date === 'invalid') err.push(`data non valida (${txt('date')})`);
        if (band === 'invalid') err.push(`fascia non valida (${txt('band')})`);

        const item: ImportRow = {
          line: r, name: name.slice(0, 200), address: address.slice(0, 300), cap,
          phone: phone === 'invalid' ? '' : phone, email: email && emailOk(email) ? email : '',
          product: txt('product').slice(0, 120), order_ref: txt('order_ref').slice(0, 60),
          date: date === 'invalid' ? null : date, band: band === 'invalid' ? null : band,
        };
        if (err.length) errors.push({ ...item, errors: err, slot: null, auto: false });
        else rows.push(item);
      }
      return { rows, errors, missing: [] };
    }
  }
  return { rows: [], errors: [], missing: ['intestazioni delle colonne (Cliente, Indirizzo, CAP, Telefono o Email)'] };
}

interface SlotRow { id: string; date: string; start: string; end: string; free: number }

/** Slot aperti dell'ambiente da oggi alla fine della finestra di prenotazione. */
export async function openSlots(db: Db, tenantId: string) {
  const b = await getBooking(db, tenantId);
  const today = todayLocal(), first = addDays(today, b.lead), last = addDays(today, b.lead + b.horizon - 1);
  const r = await db.query<{ id: string; date: string; start_time: string; end_time: string; capacity: number; booked: number }>(
    'SELECT id, date, start_time, end_time, capacity, booked FROM slots WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 AND capacity > 0 ORDER BY date, start_time',
    [tenantId, today, last],
  );
  const slots: SlotRow[] = r.rows.map((s) => ({ id: s.id, date: s.date, start: hhmm(s.start_time), end: hhmm(s.end_time), free: Math.max(s.capacity - s.booked, 0) }));
  return { slots, first, last };
}

/**
 * Sceglie lo slot per ogni riga, contando anche i posti presi dalle righe precedenti dello stesso file.
 * - data e fascia nel file: quello slot (dal giorno di oggi in poi)
 * - solo data: la prima fascia libera di quel giorno
 * - solo fascia: il primo giorno, dal preavviso minimo in poi, con quella fascia libera
 * - nessuna delle due: la prima fascia libera dal preavviso minimo in poi
 */
export const personKey = (name: string, address: string) => `${norm(name)}|${norm(address)}`;

export function planSlots(rows: ImportRow[], open: { slots: SlotRow[]; first: string }, existingRefs: Set<string>, existingPeople = new Set<string>()): PlannedRow[] {
  const free = new Map(open.slots.map((s) => [s.id, s.free]));
  const seen = new Set<string>(), seenPeople = new Set<string>();
  return rows.map((row) => {
    const errors: string[] = [];
    if (!row.order_ref) {
      // senza numero d'ordine riconosciamo i doppioni da nome e indirizzo
      const k = personKey(row.name, row.address);
      if (existingPeople.has(k)) errors.push('questo cliente ha già una consegna aperta allo stesso indirizzo');
      else if (seenPeople.has(k)) errors.push('cliente e indirizzo ripetuti nel file');
      seenPeople.add(k);
    }
    if (row.order_ref) {
      const k = row.order_ref.toLowerCase();
      if (existingRefs.has(k)) errors.push(`l'ordine ${row.order_ref} è già nel sistema`);
      else if (seen.has(k)) errors.push(`l'ordine ${row.order_ref} è ripetuto nel file`);
      seen.add(k);
    }
    const auto = !(row.date && row.band);
    const candidates = open.slots.filter((s) =>
      (row.date ? s.date === row.date : s.date >= open.first) && (row.band ? s.start === row.band : true));
    const pick = candidates.find((s) => (free.get(s.id) ?? 0) > 0);
    if (!pick) {
      if (row.date && row.band) errors.push(candidates.length ? `la fascia ${row.band} del ${it(row.date)} è piena` : `non c'è una fascia alle ${row.band} il ${it(row.date)}`);
      else if (row.date) errors.push(candidates.length ? `il ${it(row.date)} è tutto pieno` : `il ${it(row.date)} non ci sono consegne`);
      else errors.push('nessuna fascia libera nei prossimi giorni');
    }
    if (pick && !errors.length) free.set(pick.id, free.get(pick.id)! - 1);
    return { ...row, errors, slot: pick && !errors.length ? { date: pick.date, bandId: `${pick.start}-${pick.end}` } : null, auto };
  });
}

const it = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

/** Modello vuoto da scaricare e compilare. */
export async function templateWorkbook(bands: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Consegne');
  ws.columns = [
    { header: 'Ordine', key: 'o', width: 14 },
    { header: 'Cliente', key: 'n', width: 24 },
    { header: 'Indirizzo', key: 'a', width: 32 },
    { header: 'CAP', key: 'c', width: 8 },
    { header: 'Telefono', key: 't', width: 16 },
    { header: 'Email', key: 'e', width: 26 },
    { header: 'Prodotto', key: 'p', width: 18 },
    { header: 'Data', key: 'd', width: 12 },
    { header: 'Fascia', key: 'f', width: 13 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getColumn('c').numFmt = '@';
  ws.getColumn('t').numFmt = '@';
  ws.getColumn('d').numFmt = 'dd/mm/yyyy';
  ws.addRow({ o: 'A-1001', n: 'Mario Rossi', a: 'Via Roma 1, Milano', c: '20121', t: '333 1234567', e: 'mario.rossi@esempio.it', p: 'Bimby TM7', d: '', f: bands[0] ?? '' });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const help = wb.addWorksheet('Istruzioni');
  help.getColumn(1).width = 110;
  [
    'Una riga per consegna. Cancella la riga di esempio prima di caricare il file.',
    'Obbligatori: Cliente, Indirizzo, CAP e almeno uno tra Telefono ed Email.',
    'Ordine: facoltativo. Se lo lasci vuoto il sistema crea un numero.',
    'Data e Fascia: facoltative. Se le lasci vuote il sistema propone la prima fascia libera.',
    'Se scrivi solo la Data, propone la prima fascia libera di quel giorno. Se scrivi solo la Fascia, il primo giorno con quella fascia libera.',
    `Fasce attive: ${bands.join(', ') || 'vedi "Slot e capienza" nel pannello'}. Puoi scrivere anche solo l'ora di inizio, per esempio 8 o 8:00.`,
    'Telefono: anche senza +39. Il cliente riceve il messaggio su WhatsApp se c\'è il telefono, altrimenti per email.',
  ].forEach((t) => help.addRow([t]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
