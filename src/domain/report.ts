import ExcelJS from 'exceljs';
import type { Db } from '../lib/db.js';
import { config, emailEnabled } from '../config.js';
import { formatDateIt, hhmm, todayLocal } from '../lib/dates.js';
import { listDeliveries, type DeliveryView, type Status } from './deliveries.js';
import { getReportSetting } from './settings.js';
import { esc, layout, para, sendEmail } from '../notify/email.js';

/**
 * Report Excel per ambiente: tutte le consegne aperte con i dati del cliente e la situazione
 * (da confermare, confermata, da chiudere). Generato ogni N ore (impostazione "report") o a richiesta.
 */

export type Situation = 'Da confermare' | 'Confermata' | 'Da chiudere';
const KEEP = 60; // report conservati per ambiente

const STATUS_IT: Record<Status, string> = {
  proposed: 'Messaggio inviato, in attesa di risposta',
  confirmed: 'Confermata dal cliente',
  to_reschedule: 'Ha detto No, deve scegliere la nuova data',
  rescheduled: 'Nuova data scelta',
  out_of_area: "Fuori area, da contattare dall'operatore",
  no_response: 'Nessuna risposta, da contattare',
  cancelled: 'Annullata',
  delivered: 'Consegnata',
};

export function situationOf(d: DeliveryView, today = todayLocal()): Situation | null {
  if (['proposed', 'to_reschedule', 'out_of_area', 'no_response'].includes(d.status)) return 'Da confermare';
  if (d.status === 'confirmed' || d.status === 'rescheduled') return d.slot_id && d.date && d.date <= today ? 'Da chiudere' : 'Confermata';
  return null;
}

const ORDER: Situation[] = ['Da chiudere', 'Da confermare', 'Confermata'];
const FILL: Record<Situation, string> = { 'Da chiudere': 'FFFDE2E1', 'Da confermare': 'FFFFF1D6', Confermata: 'FFE2F4EA' };

export async function buildReport(db: Db, tenantId: string, tenantName: string) {
  const today = todayLocal();
  const rows = (await listDeliveries(db, tenantId, {}))
    .map((d) => ({ d, s: situationOf(d, today) }))
    .filter((x): x is { d: DeliveryView; s: Situation } => x.s !== null)
    .sort((a, b) => ORDER.indexOf(a.s) - ORDER.indexOf(b.s) || String(a.d.date ?? a.d.proposed_date).localeCompare(String(b.d.date ?? b.d.proposed_date)));
  const counts = Object.fromEntries(ORDER.map((s) => [s, rows.filter((r) => r.s === s).length])) as Record<Situation, number>;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gestione consegne';
  const now = new Date();
  const stamp = now.toLocaleString('it-IT', { timeZone: config.TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const sum = wb.addWorksheet('Riepilogo');
  sum.getColumn(1).width = 26; sum.getColumn(2).width = 14;
  sum.addRow([tenantName]).font = { bold: true, size: 14 };
  sum.addRow([`Situazione consegne al ${stamp}`]);
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

  const ws = wb.addWorksheet('Consegne', { views: [{ state: 'frozen', ySplit: 1 }] });
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

  const fileStamp = now.toLocaleString('sv-SE', { timeZone: config.TIMEZONE }).slice(0, 16).replace(' ', '_').replace(':', '');
  const filename = `consegne_${fileStamp}.xlsx`;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename, rows: rows.length, counts, stamp };
}

/** Genera, salva e (se impostato) manda per email il report di un ambiente. */
export async function createReport(db: Db, tenantId: string, trigger: 'auto' | 'manual') {
  const t = (await db.query<{ name: string; email: string }>('SELECT name, email FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t) throw new Error('Ambiente non trovato');
  const setting = await getReportSetting(db, tenantId);
  const rep = await buildReport(db, tenantId, t.name);
  const to = trigger === 'auto' && setting.email && emailEnabled() ? (setting.to || t.email) : null;
  const ins = await db.query<{ id: string; created_at: string }>(
    'INSERT INTO reports (tenant_id, filename, rows, counts, trigger, emailed_to, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at',
    [tenantId, rep.filename, rep.rows, JSON.stringify(rep.counts), trigger, to, rep.buffer],
  );
  await db.query(
    'DELETE FROM reports WHERE tenant_id = $1 AND id NOT IN (SELECT id FROM reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2)',
    [tenantId, KEEP],
  );
  if (to) {
    const c = rep.counts;
    const lines = `Da chiudere: ${c['Da chiudere']}\nDa confermare: ${c['Da confermare']}\nConfermate: ${c.Confermata}`;
    try {
      await sendEmail({ name: t.name }, to, `Situazione consegne ${rep.stamp}`,
        `In allegato la situazione delle consegne di ${t.name} al ${rep.stamp}.\n\n${lines}\n`,
        layout(para(`In allegato la situazione delle consegne di ${t.name} al ${rep.stamp}.`) + `<p>${esc(lines).replace(/\n/g, '<br>')}</p>`),
        [{ filename: rep.filename, content: rep.buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]);
    } catch (err) {
      console.error('[report] email non inviata', err);
      await db.query('UPDATE reports SET emailed_to = NULL WHERE id = $1', [ins.rows[0]!.id]);
    }
  }
  return { id: ins.rows[0]!.id, created_at: ins.rows[0]!.created_at, filename: rep.filename, rows: rep.rows, counts: rep.counts, emailed_to: to };
}

export async function listReports(db: Db, tenantId: string) {
  return (await db.query<{ id: string; created_at: string; filename: string; rows: number; counts: Record<Situation, number>; trigger: string; emailed_to: string | null }>(
    'SELECT id, created_at, filename, rows, counts, trigger, emailed_to FROM reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20',
    [tenantId],
  )).rows;
}

export async function getReportFile(db: Db, tenantId: string, id: string) {
  return (await db.query<{ filename: string; data: Buffer }>('SELECT filename, data FROM reports WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0] ?? null;
}

/** Chiamata periodicamente dalla coda: genera i report degli ambienti per cui sono passate le ore impostate. */
export async function runDueReports(db: Db, tenantIds: string[]) {
  let made = 0;
  for (const t of tenantIds) {
    const s = await getReportSetting(db, t);
    if (!s.hours) continue;
    const last = (await db.query<{ created_at: Date }>("SELECT created_at FROM reports WHERE tenant_id = $1 AND trigger = 'auto' ORDER BY created_at DESC LIMIT 1", [t])).rows[0];
    // 5 minuti di tolleranza: il controllo gira ogni 10 minuti
    if (last && Date.now() - new Date(last.created_at).getTime() < s.hours * 3600_000 - 5 * 60_000) continue;
    try { await createReport(db, t, 'auto'); made++; }
    catch (err) { console.error(`[report] ambiente ${t}`, err); }
  }
  return made;
}
