import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/lib/db.js';
import { migrate } from '../src/lib/migrate.js';
import { bookingWindow } from '../src/domain/slots.js';
import { createDelivery, declineDelivery, bookSlot, confirmDelivery, getDelivery, markDelivered, markFailedLetCustomerChoose, deleteDelivery } from '../src/domain/deliveries.js';
import { saveArea, getMessages, fillText } from '../src/domain/settings.js';
import { messageVars } from '../src/notify/notifier.js';
import { fromAddress } from '../src/notify/email.js';
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
  await pool.query('TRUNCATE delivery_events, messages, access_tokens, deliveries, customers, slots, slot_overrides, slot_templates, settings, sessions, operators, tenants CASCADE');
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
  assert.equal(fromAddress('Vorwerk Consegne <consegne@esempio.it>'), 'consegne@esempio.it');
  assert.equal(fromAddress('consegne@esempio.it'), 'consegne@esempio.it');
});
