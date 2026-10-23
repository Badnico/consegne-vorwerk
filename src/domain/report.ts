import ExcelJS from 'exceljs';
import type { Db } from '../lib/db.js';
import { config, emailEnabled } from '../config.js';
import { formatDateIt, hhmm, todayLocal } from '../lib/dates.js';
import { listDeliveries, type DeliveryView, type Status } from './deliveries.js';
import { fieldOf } from './importer.js';
import { getFeatures, getReportSetting, getReportState, saveReportState } from './settings.js';
import { esc, layout, para, sendEmail } from '../notify/email.js';

/**
 * Report Excel per ambiente: tutte le consegne aperte con i dati del cliente e la situazione
 * (da confermare, confermata, da chiudere). Generato ogni N ore (impostazione "report") o a richiesta.
 */

export type Situation = 'Da confermare' | 'Confermata' | 'Da chiudere';
const KEEP = 60; // report conservati per ambiente (al massimo)
export const RETENTION_HOURS = 48; // dopo 48 ore i report si cancellano da soli

const STATUS_IT: Record<Status, string> = {
  proposed: 'Messaggio inviato, in attesa di risposta',
  pin_check: 'Ha detto Sì, deve rispondere se ha ricevuto il PIN',
  confirmed: 'Confermata dal cliente',
  to_reschedule: 'Ha detto No, deve scegliere la nuova data',
  rescheduled: 'Nuova data scelta',
  out_of_area: "Fuori area, da contattare dall'operatore",
  no_response: 'Nessuna risposta, da contattare',
  cancelled: 'Annullata',
  delivered: 'Consegnata',
};

export function situationOf(d: DeliveryView, today = todayLocal()): Situation | null {
  if (['proposed', 'pin_check', 'to_reschedule', 'out_of_area', 'no_response'].includes(d.status)) return 'Da confermare';
  if (d.status === 'confirmed' || d.status === 'rescheduled') return d.slot_id && d.date && d.date <= today ? 'Da chiudere' : 'Confermata';
  return null;
}

const ORDER: Situation[] = ['Da chiudere', 'Da confermare', 'Confermata'];
const FILL: Record<Situation, string> = { 'Da chiudere': 'FFFDE2E1', 'Da confermare': 'FFFFF1D6', Confermata: 'FFE2F4EA' };

type Row = { d: DeliveryView; s: Situation };

/** Consegne del report, in ordine di situazione e data. */
async function reportRows(db: Db, tenantId: string): Promise<Row[]> {
  const today = todayLocal();
  return (await listDeliveries(db, tenantId, {}))
    .map((d) => ({ d, s: situationOf(d, today) }))
    .filter((x): x is Row => x.s !== null)
    .sort((a, b) => ORDER.indexOf(a.s) - ORDER.indexOf(b.s) || String(a.d.date ?? a.d.proposed_date).localeCompare(String(b.d.date ?? b.d.proposed_date)));
}

/** Nome del file caricato reso adatto al nome del report (senza estensione e caratteri strani). */
const fileTag = (name: string | null) => (name ? name.replace(/\.(xlsx|xls|csv)$/i, '') : 'inserite_a_mano')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'file';

/**
 * Un report per ogni file Excel caricato (le consegne inserite a mano in un report a parte).
 * Con un solo file, o senza file, resta un report unico come prima.
 */
export async function buildReports(db: Db, tenantId: string, tenantName: string) {
  const all = await reportRows(db, tenantId);
  const groups = new Map<string | null, Row[]>();
  for (const r of all) { const k = r.d.import_file ?? null; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  if (groups.size <= 1) return [await buildReport(db, all, tenantName, [...groups.keys()][0] ?? null, false)];
  const keys = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'it')));
  const out = [];
  for (const k of keys) out.push(await buildReport(db, groups.get(k)!, tenantName, k, true));
  return out;
}

export async function buildReport(db: Db, rows: Row[], tenantName: string, source: string | null = null, split = false) {
  const counts = Object.fromEntries(ORDER.map((s) => [s, rows.filter((r) => r.s === s).length])) as Record<Situation, number>;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gestione consegne';
  const now = new Date();
  const stamp = now.toLocaleString('it-IT', { timeZone: config.TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // prima il foglio con un cliente per riga (si apre per primo), poi il riepilogo
  const ws = wb.addWorksheet('Consegne', { views: [{ state: 'frozen', ySplit: 1 }] });
  const sum = wb.addWorksheet('Riepilogo');
  sum.getColumn(1).width = 26; sum.getColumn(2).width = 14;
  sum.addRow([tenantName]).font = { bold: true, size: 14 };
  sum.addRow([`Situazione consegne al ${stamp}`]);
  if (split || source) sum.addRow([source ? `File caricato: ${source}` : 'Consegne inserite a mano (senza file)']);
  sum.addRow([]);
  sum.addRow(['Situazione', 'Consegne']).font = { bold: true };
  for (const s of ORDER) {
    const r = sum.addRow([s, counts[s]]);
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[s] } };
  }
  sum.addRow(['Totale', rows.length]).font = { bold: true };
  sum.addRow([]);
  sum.addRow(['Da chiudere: consegne confermate di oggi o dei giorni passati che aspettano l\'esito (consegnata o non consegnata).']);
  sum.addRow(['Da confermare: il cliente non ha ancora risposto, deve scegliere la nuova data o va contattato.']);

  // Se le consegne arrivano da un file Excel: stesse colonne del file, con "Situazione" come prima colonna
  if (rows.some((r) => r.d.source?.length)) writeSourceSheet(ws, rows, await typedMessages(db, rows.map((r) => r.d.id)));
  else writeStandardSheet(ws, rows);

  const fileStamp = now.toLocaleString('sv-SE', { timeZone: config.TIMEZONE }).slice(0, 16).replace(' ', '_').replace(':', '');
  const filename = split ? `consegne_${fileStamp}_${fileTag(source)}.xlsx` : `consegne_${fileStamp}.xlsx`;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename, rows: rows.length, counts, stamp, source };
}

function writeStandardSheet(ws: ExcelJS.Worksheet, rows: { d: DeliveryView; s: Situation }[]) {
  ws.columns = [
    { header: 'Situazione', key: 'sit', width: 15 },
    { header: 'Dettaglio', key: 'st', width: 40 },
    { header: 'Ordine', key: 'ord', width: 14 },
    { header: 'Cliente', key: 'name', width: 24 },
    { header: 'Telefono', key: 'tel', width: 16 },
    { header: 'Email', key: 'mail', width: 28 },
    { header: 'Indirizzo', key: 'addr', width: 34 },
    { header: 'CAP', key: 'cap', width: 8 },
    { header: 'Prodotto', key: 'prod', width: 18 },
    { header: 'Data consegna', key: 'date', width: 14 },
    { header: 'Fascia', key: 'band', width: 13 },
    { header: 'Data proposta all\'inizio', key: 'pdate', width: 22 },
    { header: 'Consegne non riuscite', key: 'fail', width: 12 },
    { header: 'Inserita il', key: 'created', width: 12 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  const asDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
  for (const { d, s } of rows) {
    const booked = Boolean(d.slot_id);
    const r = ws.addRow({
      sit: s,
      st: STATUS_IT[d.status],
      ord: d.order_ref,
      name: d.customer_name,
      tel: d.phone_e164 ?? '',
      mail: d.email ?? '',
      addr: d.address,
      cap: d.cap ?? '',
      prod: d.product ?? '',
      date: booked ? asDate(d.date) : null,
      band: booked && d.start_time && d.end_time ? `${hhmm(d.start_time)}-${hhmm(d.end_time)}` : '',
      pdate: `${formatDateIt(d.proposed_date)}, ${hhmm(d.proposed_start)}-${hhmm(d.proposed_end)}`,
      fail: d.failed_attempts || null,
      created: new Date(d.created_at),
    });
    r.getCell('sit').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[s] } };
  }
  ws.getColumn('date').numFmt = 'dd/mm/yyyy';
  ws.getColumn('created').numFmt = 'dd/mm/yyyy';
  ws.getColumn('cap').numFmt = '@';
  if (rows.length) ws.autoFilter = { from: 'A1', to: { row: rows.length + 1, column: ws.columns.length } };

}

/** Valore di una colonna del file per una consegna inserita a mano (senza riga originale). */
function valueFor(d: DeliveryView, header: string): unknown {
  switch (fieldOf(header)) {
    case 'name': return d.customer_name;
    case 'address': return d.address;
    case 'city': return d.city ?? '';
    case 'province': return d.province ?? '';
    case 'cap': return d.cap ?? '';
    case 'phone': return d.phone_e164 ?? '';
    case 'email': return d.email ?? '';
    case 'product': return d.product ?? '';
    case 'order_ref': return d.order_ref;
    case 'cod': return Number(d.cod_amount) || 0;
    default: return null;
  }
}

export const MESSAGES_HEADER = 'Messaggi cliente';
const LAST_EVENT_HEADER = 'ultimo evento t&t';
const norm = (h: unknown) => String(h).trim().toLowerCase();
const MESSAGES_HEADER_KEY = Symbol('messaggi');

/**
 * Messaggi scritti dal cliente su WhatsApp con la tastiera, uno per riga con giorno e ora.
 * Esclusi i pulsanti Sì/No (kind 'reply') e foto, vocali, documenti (tipo diverso da 'text').
 */
export async function typedMessages(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await db.query<{ delivery_id: string; body: string; created_at: Date }>(
    `SELECT delivery_id, body, created_at FROM messages
      WHERE delivery_id = ANY($1::uuid[]) AND direction = 'in' AND kind = 'text'
        AND payload->>'type' = 'text' AND coalesce(btrim(body), '') <> ''
      ORDER BY created_at, id`,
    [ids],
  );
  const out = new Map<string, string[]>();
  for (const m of r.rows) {
    const when = new Date(m.created_at).toLocaleString('it-IT', { timeZone: config.TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
    const list = out.get(m.delivery_id) ?? [];
    list.push(`${when} ${m.body.trim()}`);
    out.set(m.delivery_id, list);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
}

/**
 * Ordine delle colonne del file nel report: la colonna "Messaggi cliente" prende il posto di
 * "Ultimo Evento T&T", che si sposta due colonne più avanti (dopo la colonna che la seguiva).
 * Se il file non ha "Ultimo Evento T&T", i messaggi vanno in fondo.
 */
export function sourceColumns(headers: string[]): (string | typeof MESSAGES_HEADER_KEY)[] {
  const cols: (string | typeof MESSAGES_HEADER_KEY)[] = [...headers];
  const i = headers.findIndex((h) => norm(h) === LAST_EVENT_HEADER);
  if (i < 0) { cols.push(MESSAGES_HEADER_KEY); return cols; }
  const [last] = cols.splice(i, 1, MESSAGES_HEADER_KEY);
  cols.splice(Math.min(i + 2, cols.length), 0, last!);
  return cols;
}
function writeSourceSheet(ws: ExcelJS.Worksheet, rows: { d: DeliveryView; s: Situation }[], messages: Map<string, string>) {
  // colonne: tutte quelle dei fogli caricati, nell'ordine in cui compaiono
  const headers: string[] = [];
  // le colonne che aggiunge il portale non si ripetono (succede se si ricarica un report come file di consegne)
  const own = new Set(['situazione', 'dettaglio', 'data consegna', 'fascia consegna', norm(MESSAGES_HEADER)]);
  for (const { d } of rows) for (const c of d.source ?? []) if (!headers.includes(c.h) && !own.has(norm(c.h))) headers.push(c.h);
  const cols = sourceColumns(headers);
  // dopo "Situazione": stato preciso, giorno e fascia di consegna assegnati dal portale
  ws.columns = [
    { header: 'Situazione', key: 'sit', width: 15 },
    { header: 'Dettaglio', key: 'st', width: 26 },
    { header: 'Data consegna', key: 'sdate', width: 13 },
    { header: 'Fascia consegna', key: 'sband', width: 14 },
    ...cols.map((h) => h === MESSAGES_HEADER_KEY
      ? { header: MESSAGES_HEADER, key: 'msg', width: 50 }
      : { header: h, key: `c${headers.indexOf(h)}`, width: Math.min(Math.max(h.length + 2, 10), 34) }),
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  for (const { d, s } of rows) {
    const slot = slotOf(d);
    const values: Record<string, unknown> = { sit: s, st: STATUS_IT[d.status], sdate: slot.date, sband: slot.band, msg: messages.get(d.id) ?? null };
    headers.forEach((h, i) => {
      const c = d.source?.find((x) => x.h === h);
      let v: unknown = c ? c.v : d.source?.length ? null : valueFor(d, h);
      if (v && typeof v === 'object' && 'd' in (v as object)) { const dt = new Date((v as { d: string }).d); v = isNaN(dt.getTime()) ? null : dt; }
      values[`c${i}`] = v ?? null;
    });
    const r = ws.addRow(values);
    r.getCell('sit').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[s] } };
    r.getCell('msg').alignment = { vertical: 'top', wrapText: true };
    r.eachCell((cell) => { if (cell.value instanceof Date) cell.numFmt = 'dd/mm/yyyy'; });
  }
  if (rows.length) ws.autoFilter = { from: 'A1', to: { row: rows.length + 1, column: cols.length + 4 } };
}

/** Giorno e fascia occupati dalla consegna (vuoti se non ne ha: da riprogrammare, fuori area). */
function slotOf(d: DeliveryView) {
  if (!d.slot_id || !d.date || !d.start_time || !d.end_time) return { date: null, band: '' };
  return { date: new Date(`${d.date}T00:00:00Z`), band: `${hhmm(d.start_time)}-${hhmm(d.end_time)}` };
}

/** Genera, salva e (se impostato) manda per email i report di un ambiente: uno per ogni file caricato. */
export async function createReport(db: Db, tenantId: string, trigger: 'auto' | 'time' | 'manual') {
  const t = (await db.query<{ name: string; email: string }>('SELECT name, email FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t) throw new Error('Ambiente non trovato');
  const setting = await getReportSetting(db, tenantId);
  const reps = await buildReports(db, tenantId, t.name);
  const to = trigger !== 'manual' && setting.email && emailEnabled() ? (setting.to || t.email) : null;
  const saved: { id: string; created_at: string; filename: string; rows: number; counts: Record<Situation, number>; source_file: string | null }[] = [];
  for (const rep of reps) {
    const ins = await db.query<{ id: string; created_at: string }>(
      'INSERT INTO reports (tenant_id, filename, rows, counts, trigger, emailed_to, data, source_file) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at',
      [tenantId, rep.filename, rep.rows, JSON.stringify(rep.counts), trigger, to, rep.buffer, rep.source],
    );
    saved.push({ id: ins.rows[0]!.id, created_at: ins.rows[0]!.created_at, filename: rep.filename, rows: rep.rows, counts: rep.counts, source_file: rep.source });
  }
  await db.query(
    'DELETE FROM reports WHERE tenant_id = $1 AND id NOT IN (SELECT id FROM reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2)',
    [tenantId, KEEP],
  );
  if (trigger === 'auto') await saveReportState(db, tenantId, { lastAuto: new Date().toISOString() });
  if (trigger === 'time') await saveReportState(db, tenantId, { lastTimeDay: todayLocal(config.TIMEZONE), lastTimeAt: setting.at });
  console.log(`[report] creato (${trigger}) per ${t.name}: ${reps.length} file${to ? ` → invio email a ${to}` : setting.email && trigger !== 'manual' && !emailEnabled() ? ' (email non configurata sul server)' : ''}`);
  const stamp = reps[0]!.stamp;
  if (to) {
    const lines = reps.map((r) => `${reps.length > 1 ? `${r.source ?? 'Inserite a mano'}: ` : ''}Da chiudere ${r.counts['Da chiudere']} · Da confermare ${r.counts['Da confermare']} · Confermate ${r.counts.Confermata}`).join('\n');
    const intro = reps.length > 1 ? `In allegato la situazione delle consegne di ${t.name} al ${stamp}, un file per ogni file caricato.` : `In allegato la situazione delle consegne di ${t.name} al ${stamp}.`;
    try {
      await sendEmail({ name: t.name }, to, `Situazione consegne ${stamp}`,
        `${intro}\n\n${lines}\n`,
        layout(para(intro) + `<p>${esc(lines).replace(/\n/g, '<br>')}</p>`),
        reps.map((r) => ({ filename: r.filename, content: r.buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })));
      console.log(`[report] email inviata a ${to}`);
    } catch (err) {
      console.error('[report] email non inviata', err);
      await db.query('UPDATE reports SET emailed_to = NULL WHERE id = ANY($1::uuid[])', [saved.map((x) => x.id)]);
    }
  }
  const first = saved[0]!;
  return { ...first, emailed_to: to, reports: saved };
}

export async function listReports(db: Db, tenantId: string) {
  return (await db.query<{ id: string; created_at: string; filename: string; rows: number; counts: Record<Situation, number>; trigger: string; emailed_to: string | null }>(
    `SELECT id, created_at, created_at + interval '${RETENTION_HOURS} hours' AS expires_at, filename, rows, counts, trigger, emailed_to, source_file
       FROM reports WHERE tenant_id = $1 AND created_at > now() - interval '${RETENTION_HOURS} hours' ORDER BY created_at DESC LIMIT 60`,
    [tenantId],
  )).rows;
}

export async function getReportFile(db: Db, tenantId: string, id: string) {
  return (await db.query<{ filename: string; data: Buffer }>(
    `SELECT filename, data FROM reports WHERE tenant_id = $1 AND id = $2 AND created_at > now() - interval '${RETENTION_HOURS} hours'`, [tenantId, id],
  )).rows[0] ?? null;
}

/** Cancella subito un report (pulsante nel pannello). */
export async function deleteReport(db: Db, tenantId: string, id: string) {
  return ((await db.query('DELETE FROM reports WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rowCount ?? 0) > 0;
}

/** Cancella i report più vecchi di 48 ore (tutti gli ambienti). */
export async function purgeExpiredReports(db: Db) {
  return (await db.query(`DELETE FROM reports WHERE created_at < now() - interval '${RETENTION_HOURS} hours'`)).rowCount ?? 0;
}

/** Chiamata periodicamente dalla coda: genera i report degli ambienti per cui sono passate le ore impostate. */
export async function runDueReports(db: Db, tenantIds: string[]) {
  let made = 0;
  for (const t of tenantIds) {
    const s = await getReportSetting(db, t);
    if (s.at && (await getFeatures(db, t)).reportAtTime && await dueAtTime(db, t, s.at)) {
      try { await createReport(db, t, 'time'); made++; }
      catch (err) { console.error(`[report] ambiente ${t}`, err); }
    }
    if (!s.hours) continue;
    // l'ultimo invio si ricorda anche se il file è già stato cancellato (a mano o dopo 48 ore)
    const lastAuto = (await getReportState(db, t)).lastAuto
      ?? (await db.query<{ created_at: Date }>("SELECT created_at FROM reports WHERE tenant_id = $1 AND trigger = 'auto' ORDER BY created_at DESC LIMIT 1", [t])).rows[0]?.created_at;
    // qualche minuto di tolleranza sul controllo periodico
    if (lastAuto && Date.now() - new Date(lastAuto).getTime() < s.hours * 3600_000 - 5 * 60_000) continue;
    try { await createReport(db, t, 'auto'); made++; }
    catch (err) { console.error(`[report] ambiente ${t}`, err); }
  }
  return made;
}

/** Ora locale "HH:MM" (fuso dell'applicazione). */
export function localHHMM(d = new Date(), tz = config.TIMEZONE) {
  return d.toLocaleTimeString('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Report "ogni giorno alle HH:MM": dovuto se l'ora è passata da meno di 2 ore (recupera eventuali riavvii)
 * e oggi non è ancora stato fatto.
 */
export async function dueAtTime(db: Db, tenantId: string, at: string, now = new Date()) {
  const toMin = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  const late = toMin(localHHMM(now)) - toMin(at);
  if (late < 0 || late >= 120) return false;
  // una volta al giorno PER ORARIO: se l'orario viene cambiato, il nuovo vale già da oggi
  const st = await getReportState(db, tenantId);
  if (st.lastTimeDay === todayLocal(config.TIMEZONE) && st.lastTimeAt === at) return false; // già fatto (anche se poi cancellato)
  // già creato oggi un report a orario fisso dopo l'orario impostato?
  const done = await db.query(
    `SELECT 1 FROM reports WHERE tenant_id = $1 AND trigger = 'time'
        AND (created_at AT TIME ZONE $2)::date = $3::date
        AND to_char(created_at AT TIME ZONE $2, 'HH24:MI') >= $4`,
    [tenantId, config.TIMEZONE, todayLocal(config.TIMEZONE), at],
  );
  return !done.rowCount;
}
