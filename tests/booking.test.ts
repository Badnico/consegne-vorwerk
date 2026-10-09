import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/lib/db.js';
import { migrate } from '../src/lib/migrate.js';
import { bookingWindow } from '../src/domain/slots.js';
import { createDelivery, declineDelivery, bookSlot, confirmDelivery, getDelivery, markDelivered, markFailedLetCustomerChoose, deleteDelivery } from '../src/domain/deliveries.js';
import { canSelfBook, saveArea, getMessages, fillText } from '../src/domain/settings.js';
import { messageVars } from '../src/notify/notifier.js';
import { fromAddress } from '../src/notify/email.js';
import ExcelJS from 'exceljs';
import { openSlots, parseWorkbook, planSlots } from '../src/domain/importer.js';
import { createReport, getReportFile, listReports, runDueReports, situationOf } from '../src/domain/report.js';
import { saveReportSetting } from '../src/domain/settings.js';
import { createTenant, updateTenant } from '../src/domain/tenants.js';
import { loginTenant } from '../src/lib/auth.js';
import { addDays, todayLocal } from '../src/lib/dates.js';
import { createToken, resolveToken } from '../src/domain/tokens.js';

// Richiede un Postgres di test: DATABASE_URL=postgres://.../consegne_test npm test

let day: string;
let T: string, T2: string; // due ambienti
let n = 0;
const order = () => `T-${Date.now()}-${n++}`;
const customer = { name: 'Giulia Ferri', email: 'giulia@example.it' };

async function slot(start: string, capacity: number) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO slots (tenant_id, date, start_time, end_time, capacity) VALUES ($4, $1, $2, ($2::time + interval '3 hours'), $3) RETURNING id`,
    [day, start, capacity, T],
  );
  return r.rows[0]!.id;
}
const booked = async (id: string) => (await pool.query<{ booked: number }>('SELECT booked FROM slots WHERE id = $1', [id])).rows[0]!.booked;

before(async () => {
  await migrate();
  await pool.query('TRUNCATE reports, delivery_events, messages, access_tokens, deliveries, customers, slots, slot_overrides, slot_templates, settings, sessions, operators, tenants CASCADE');
  const end = addDays(todayLocal(), 30);
  T = await createTenant({ name: 'Uno', slug: 'uno', username: 'uno', password: 'password-lunga-1', email: 'uno@example.it', subscription_end: end });
  T2 = await createTenant({ name: 'Due', slug: 'due', username: 'due', password: 'password-lunga-2', email: 'due@example.it', subscription_end: end });
  await pool.query('DELETE FROM slots WHERE tenant_id = $1', [T]); // nei test gli slot li creiamo a mano
  day = (await bookingWindow(pool, T)).from;
});
after(() => pool.end());

test('dieci proposte in parallelo su 3 posti: ne passano esattamente 3', async () => {
  const s = await slot('08:00', 3);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => createDelivery(T, { order_ref: order(), customer, address: 'Via Padova 1, Milano', slot_id: s }, 'test')),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(await booked(s), 3);
});

test('il No libera il posto, la nuova scelta lo occupa altrove', async () => {
  const a = await slot('11:00', 1), b = await slot('14:00', 2);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Padova 1, Milano', slot_id: a }, 'test');
  assert.equal(await booked(a), 1);
  await declineDelivery(id);
  assert.equal(await booked(a), 0);
  await bookSlot(id, b);
  assert.equal(await booked(b), 1);
  const d = await getDelivery(pool, id);
  assert.equal(d.status, 'rescheduled');
  assert.equal(d.slot_id, b);
});

test("due clienti sull'ultimo posto: uno solo lo ottiene, l'altro riceve slot_full", async () => {
  const p = await slot('17:00', 5), last = await slot('19:00', 1);
  const ids = await Promise.all([1, 2].map(() => createDelivery(T, { order_ref: order(), customer, address: 'Corso Lodi 4, Milano', slot_id: p }, 'test')));
  await Promise.all(ids.map((id) => declineDelivery(id)));
  const res = await Promise.allSettled(ids.map((id) => bookSlot(id, last)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'slot_full');
  assert.equal(await booked(last), 1);
});

test('il Sì su una consegna già riprogrammata viene rifiutato', async () => {
  const a = await slot('20:00', 2);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Novara 3, Milano', slot_id: a }, 'test');
  await declineDelivery(id);
  await assert.rejects(confirmDelivery(id), { code: 'invalid_state' });
});

test('il link porta alla consegna giusta e scade', async () => {
  const a = await slot('06:00', 2);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Tortona 9, Milano', slot_id: a }, 'test');
  const token = await createToken(pool, id, day);
  assert.equal(await resolveToken(pool, token), id);
  await pool.query(`UPDATE access_tokens SET expires_at = now() - interval '1 minute' WHERE delivery_id = $1`, [id]);
  await assert.rejects(resolveToken(pool, token), { code: 'link_expired' });
  await assert.rejects(resolveToken(pool, 'non-valido'), { code: 'link_expired' });
});

test("No fuori dall'area: passa all'operatore, il cliente non può scegliere, l'operatore sì", async () => {
  await saveArea(pool, T, { on: true, list: '20121-20162' });
  const a = await slot('07:00', 2), b = await slot('07:30', 2);
  const out = await createDelivery(T, { order_ref: order(), customer, address: 'Via Italia 12, Monza', cap: '20900', slot_id: a }, 'test');
  const inn = await createDelivery(T, { order_ref: order(), customer, address: 'Via Padova 1, Milano', cap: '20132', slot_id: a }, 'test');
  assert.equal(await declineDelivery(out), 'out_of_area');
  assert.equal(await declineDelivery(inn), 'to_reschedule');
  assert.equal(await booked(a), 0);
  await assert.rejects(bookSlot(out, b), { code: 'invalid_state' });
  await bookSlot(out, b, 'operator:test');
  assert.equal((await getDelivery(pool, out)).status, 'rescheduled');
  await saveArea(pool, T, { on: false, list: '' });
});

test('esito: consegnata, non consegnata, eliminazione libera il posto', async () => {
  const a = await slot('21:00', 3);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Padova 1, Milano', cap: '20132', slot_id: a }, 'test');
  await assert.rejects(markDelivered(id, 'operator:test'), { code: 'invalid_state' }); // non ancora confermata
  await confirmDelivery(id);
  assert.equal(await markFailedLetCustomerChoose(id, 'operator:test'), 'to_reschedule');
  const d = await getDelivery(pool, id);
  assert.equal(d.failed_attempts, 1);
  assert.equal(await booked(a), 0);
  await bookSlot(id, a, 'operator:test');
  await markDelivered(id, 'operator:test');
  assert.equal((await getDelivery(pool, id)).status, 'delivered');
  await deleteDelivery(id);
  assert.equal(await booked(a), 0);
});

test('ambienti separati: un ambiente non vede né modifica le consegne di un altro', async () => {
  const a = await slot('22:00', 2);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Padova 1, Milano', slot_id: a }, 'test');
  await assert.rejects(getDelivery(pool, id, T2), { code: 'not_found' });
  await assert.rejects(confirmDelivery(id, 'operator:due', T2), { code: 'not_found' });
  await assert.rejects(deleteDelivery(id, T2), { code: 'not_found' });
  await assert.rejects(createDelivery(T2, { order_ref: order(), customer, address: 'x', slot_id: a }, 'test'), { code: 'not_found' }); // slot di un altro ambiente
  assert.equal((await getDelivery(pool, id, T)).status, 'proposed');
});

test("abbonamento: scaduto o sospeso blocca l'accesso, il rinnovo lo riapre", async () => {
  assert.equal((await loginTenant('uno', 'uno', 'password-lunga-1')).ok, true);
  assert.equal((await loginTenant('uno', 'uno', 'sbagliata')).ok, false);
  assert.equal((await loginTenant('due', 'uno', 'password-lunga-1')).ok, false); // utente di un altro ambiente
  await updateTenant(T, { subscription_end: addDays(todayLocal(), -1) });
  const r = await loginTenant('uno', 'uno', 'password-lunga-1');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'expired');
  await updateTenant(T, { subscription_end: addDays(todayLocal(), 0) }); // valido fino a oggi compreso
  assert.equal((await loginTenant('uno', 'uno', 'password-lunga-1')).ok, true);
  await updateTenant(T, { suspended: true });
  const s2 = await loginTenant('uno', 'uno', 'password-lunga-1');
  assert.equal(!s2.ok && s2.reason, 'suspended');
  await updateTenant(T, { suspended: false, password: 'nuova-password-123' });
  assert.equal((await loginTenant('uno', 'uno', 'password-lunga-1')).ok, false);
  assert.equal((await loginTenant('uno', 'uno', 'nuova-password-123')).ok, true);
});

test("modo A: ogni messaggio porta il nome dell'azienda dell'ambiente", async () => {
  const a = await slot('23:00', 2);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Torino 2, Milano', slot_id: a }, 'test');
  const d = await getDelivery(pool, id, T);
  assert.equal(d.tenant_name, 'Uno');
  assert.equal(d.tenant_email, 'uno@example.it');
  const m = await getMessages(pool, T);
  const v = messageVars(d, 'proposed');
  assert.match(fillText(m.wa_proposal, v), /per conto di Uno\./);
  assert.match(fillText(m.mail_subject, v), /^Uno: la tua consegna /);
  assert.equal(fromAddress('Servizio Consegne <consegne@esempio.it>'), 'consegne@esempio.it');
  assert.equal(fromAddress('consegne@esempio.it'), 'consegne@esempio.it');
});

test('Excel: intestazioni con sinonimi, CAP e telefono numerici, date e fasce in vari formati, righe con errori', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Foglio1');
  ws.addRow(['Elenco consegne settimana']); // titolo sopra l'intestazione
  ws.addRow(['Nome', 'Cognome', 'Indirizzo', 'Città', 'C.A.P.', 'Cellulare', 'E-mail', 'Prodotto', 'N. ordine', 'Data consegna', 'Fascia oraria']);
  ws.addRow(['Anna', 'Neri', 'Via Verdi 2', 'Milano', 2121, 3331234567, '', 'Bimby', 'X-1', new Date(Date.UTC(2030, 0, 15)), '8-11']);
  ws.addRow(['Bruno', 'Galli', 'Corso Como 5, Milano', '', '201', '', 'bruno@example.it', '', '', '', '']);
  ws.addRow([]);
  ws.addRow(['Carla', '', 'Via Po 9', 'Torino', '10121', '', '', '', '', '', '']);
  ws.addRow(['Dario', 'Russo', 'Via Manzoni 1', 'Milano', '20121', '+39 340 111 2222', 'dario@example.it', '', 'X-2', '31/02/2030', '']);
  ws.addRow(['Elena', 'Costa', 'Via Dante 7', 'Milano', '20122', '0039 347 5556666', '', '', '', '20/01/30', '14:00']);
  const { rows, errors, missing } = await parseWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(missing, []);
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 3);
  const anna = rows.find((r) => r.name === 'Anna Neri')!;
  assert.equal(anna.address, 'Via Verdi 2, Milano');
  assert.equal(anna.cap, '02121');
  assert.equal(anna.phone, '+393331234567');
  assert.equal(anna.date, '2030-01-15');
  assert.equal(anna.band, '08:00');
  assert.equal(anna.order_ref, 'X-1');
  const elena = rows.find((r) => r.name === 'Elena Costa')!;
  assert.equal(elena.phone, '+393475556666');
  assert.equal(elena.date, '2030-01-20');
  assert.equal(elena.band, '14:00');
  assert.match(errors.find((e) => e.name === 'Bruno Galli')!.errors.join(), /CAP non valido/);
  assert.match(errors.find((e) => e.name === 'Carla')!.errors.join(), /telefono o email/);
  assert.match(errors.find((e) => e.name === 'Dario Russo')!.errors.join(), /data non valida/);
});

test('Excel: le fasce proposte rispettano la capienza, anche tra righe dello stesso file', async () => {
  const open = { first: '2030-01-02', slots: [
    { id: 'a', date: '2030-01-01', start: '08:00', end: '11:00', free: 5 }, // prima del preavviso: solo se chiesta
    { id: 'b', date: '2030-01-02', start: '08:00', end: '11:00', free: 1 },
    { id: 'c', date: '2030-01-02', start: '11:00', end: '14:00', free: 1 },
    { id: 'd', date: '2030-01-03', start: '08:00', end: '11:00', free: 0 },
  ] };
  const base = { name: 'X', address: 'Via 1', cap: '20121', phone: '+393331112222', email: '', product: '' };
  const plan = planSlots([
    { ...base, line: 2, order_ref: 'A1', date: null, band: null },
    { ...base, line: 3, order_ref: 'A2', date: null, band: null },
    { ...base, line: 4, order_ref: 'A3', date: null, band: null },
    { ...base, line: 5, order_ref: 'a1', date: '2030-01-01', band: '08:00' },
    { ...base, line: 6, order_ref: 'OLD', date: '2030-01-01', band: null },
    { ...base, line: 7, order_ref: '', date: '2030-01-03', band: '08:00' },
  ], open, new Set(['old']));
  assert.deepEqual(plan[0]!.slot, { date: '2030-01-02', bandId: '08:00-11:00' });
  assert.deepEqual(plan[1]!.slot, { date: '2030-01-02', bandId: '11:00-14:00' });
  assert.match(plan[2]!.slotIssue ?? '', /nessuna fascia libera/);
  assert.match(plan[3]!.errors.join(), /ripetuto nel file/);
  assert.match(plan[4]!.errors.join(), /già nel sistema/);
  assert.match(plan[5]!.slotIssue ?? '', /piena/);
  assert.equal(plan[5]!.errors.length, 0); // dati giusti: basta scegliere un'altra fascia
});

test('report Excel: situazioni da confermare, confermate e da chiudere', async () => {
  const open = await openSlots(pool, T2);
  const s0 = open.slots.find((s) => s.free > 0 && s.date >= open.first)!;
  const mk = async () => createDelivery(T2, { order_ref: order(), customer, address: 'Via Report 1, Milano', cap: '20121', slot_id: s0.id }, 'test');
  const a = await mk(), b2 = await mk(), c = await mk();
  await confirmDelivery(b2, 'test', T2);
  await confirmDelivery(c, 'test', T2);
  // c: data passata → da chiudere
  const past = await pool.query<{ id: string }>(`INSERT INTO slots (tenant_id, date, start_time, end_time, capacity, booked) VALUES ($1, $2, '07:00', '08:00', 5, 1) RETURNING id`, [T2, addDays(todayLocal(), -1)]);
  await pool.query('UPDATE deliveries SET slot_id = $1 WHERE id = $2', [past.rows[0]!.id, c]);
  assert.equal(situationOf(await getDelivery(pool, a, T2)), 'Da confermare');
  assert.equal(situationOf(await getDelivery(pool, b2, T2)), 'Confermata');
  assert.equal(situationOf(await getDelivery(pool, c, T2)), 'Da chiudere');

  const rep = await createReport(pool, T2, 'manual');
  assert.equal(rep.counts['Da confermare'], 1);
  assert.equal(rep.counts.Confermata, 1);
  assert.equal(rep.counts['Da chiudere'], 1);
  assert.equal((await listReports(pool, T2))[0]!.id, rep.id);
  assert.equal(await getReportFile(pool, T, rep.id), null); // non visibile da un altro ambiente
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await getReportFile(pool, T2, rep.id))!.data as unknown as ArrayBuffer);
  assert.equal(wb.worksheets[0]!.name, 'Consegne'); // si apre sul foglio con un cliente per riga
  const ws = wb.getWorksheet('Consegne')!;
  assert.equal(ws.rowCount, 4);
  assert.equal(ws.getRow(2).getCell(1).value, 'Da chiudere');
  assert.equal(ws.getRow(2).getCell(4).value, 'Giulia Ferri');
});

test('report automatico: parte quando sono passate le ore impostate, non prima', async () => {
  await saveReportSetting(pool, T, { hours: 0, email: false, to: '' });
  assert.equal(await runDueReports(pool, [T]), 0); // spento
  await saveReportSetting(pool, T, { hours: 2, email: false, to: '' });
  assert.equal(await runDueReports(pool, [T]), 1); // primo report
  assert.equal(await runDueReports(pool, [T]), 0); // troppo presto
  await pool.query("UPDATE reports SET created_at = now() - interval '2 hours' WHERE tenant_id = $1", [T]);
  assert.equal(await runDueReports(pool, [T]), 1);
});

test('Excel: senza numero d\'ordine riconosce i doppioni da nome e indirizzo', () => {
  const open = { first: '2030-01-02', slots: [{ id: 'b', date: '2030-01-02', start: '08:00', end: '11:00', free: 9 }] };
  const base = { address: 'Via 1, Milano', cap: '20121', phone: '+393331112222', email: '', product: '', order_ref: '', date: null, band: null };
  const plan = planSlots([
    { ...base, line: 2, name: 'Anna Neri' },
    { ...base, line: 3, name: 'anna neri ' },
    { ...base, line: 4, name: 'Bruno Galli' },
  ], open, new Set(), new Set(['bruno galli|via 1 milano']));
  assert.equal(plan[0]!.errors.length, 0);
  assert.match(plan[1]!.errors.join(), /ripetuti nel file/);
  assert.match(plan[2]!.errors.join(), /già una consegna aperta/);
});

test('"Se clicca NO va richiamato": tutti quelli che dicono No passano all\'operatore', async () => {
  assert.equal(canSelfBook({ on: false, list: '', callAll: true }, '20121'), false);
  assert.equal(canSelfBook({ on: false, list: '' }, '20121'), true);
  await saveArea(pool, T, { on: false, list: '', callAll: true });
  const a = await slot('21:00', 3);
  const id = await createDelivery(T, { order_ref: order(), customer, address: 'Via Roma 1, Milano', cap: '20121', slot_id: a }, 'test');
  assert.equal(await declineDelivery(id, 'customer', T), 'out_of_area');
  await assert.rejects(bookSlot(id, a, 'customer')); // il cliente non sceglie da solo
  await saveArea(pool, T, { on: false, list: '', callAll: false });
});
