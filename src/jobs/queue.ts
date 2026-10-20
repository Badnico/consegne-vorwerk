import PgBoss from 'pg-boss';
import { config } from '../config.js';
import { DomainError } from '../lib/errors.js';
import { pool } from '../lib/db.js';
import { getDelivery, markNoResponse, type Status } from '../domain/deliveries.js';
import { refreshPendingTemplates } from '../domain/watemplate.js';
import { claimReminder, dueTimers, releaseReminder, reminderStillDue } from '../domain/timing.js';
import { activeTenantIds, generateSlots } from '../domain/slots.js';
import { purgeExpiredReports, runDueReports } from '../domain/report.js';
import { getTiming } from '../domain/settings.js';
import { sendPinQuestion, sendConfirmation, sendOutOfArea, sendProposal, sendRescheduleLink } from '../notify/notifier.js';

/**
 * Coda dei lavori su Postgres (pg-boss): nessun Redis da gestire.
 * Ogni invio è un job con ritentativi; i solleciti e le scadenze sono job ritardati.
 */
export const Q = {
  proposal: 'send-proposal',
  reminder: 'send-reminder',
  afterDecline: 'after-decline',
  afterConfirm: 'after-confirm',
  expire: 'expire-delivery',
  slots: 'generate-slots',
  reports: 'periodic-reports',
  askPin: 'ask-pin',
  timers: 'reminder-timers',
} as const;

type IdJob = { deliveryId: string };
type ExpireJob = IdJob & { ifStatus: Status };

let boss: PgBoss | null = null;

export async function startQueue({ work }: { work: boolean }) {
  boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on('error', (err) => console.error('[queue]', err));
  await boss.start();
  for (const name of Object.values(Q)) await boss.createQueue(name);
  if (work) await registerWorkers(boss);
  return boss;
}

export async function stopQueue() {
  await boss?.stop({ graceful: true });
}

const retry = { retryLimit: 5, retryDelay: 60, retryBackoff: true };

function q() {
  if (!boss) throw new Error('Coda non avviata');
  return boss;
}

export const enqueue = {
  proposal: (deliveryId: string) => q().send(Q.proposal, { deliveryId }, { ...retry, singletonKey: `proposal:${deliveryId}` }),
  afterDecline: (deliveryId: string) => q().send(Q.afterDecline, { deliveryId }, retry),
  afterConfirm: (deliveryId: string) => q().send(Q.afterConfirm, { deliveryId }, retry),
  askPin: (deliveryId: string) => q().send(Q.askPin, { deliveryId }, retry),
};

/** Una consegna eliminata dal pannello non deve far fallire (e ritentare) i suoi invii in coda. */
function safe<T>(handler: (jobs: PgBoss.Job<T>[]) => Promise<void>) {
  return async (jobs: PgBoss.Job<T>[]) => {
    try { await handler(jobs); }
    catch (err) {
      if (err instanceof DomainError && err.code === 'not_found') return;
      console.error('[coda] lavoro non riuscito, verrà ritentato:', err);
      throw err;
    }
  };
}

async function registerWorkers(b: PgBoss) {
  await b.work<IdJob>(Q.proposal, safe(async ([job]) => {
    const id = job!.data.deliveryId;
    await sendProposal(id, 'proposal');
    // sollecito e "Senza risposta" li gestisce il controllo di ogni minuto (Q.timers) con i tempi attuali dell'azienda
  }));

  await b.work<IdJob>(Q.reminder, safe(async ([job]) => {
    const id = job!.data.deliveryId;
    const d = await getDelivery(pool, id);
    if (d.status !== 'proposed') return;
    // i lavori messi in coda prima di un cambio dei tempi seguono comunque i tempi attuali
    if (!(await reminderStillDue(pool, id, await getTiming(pool, d.tenant_id)))) return;
    if (!(await claimReminder(pool, id))) return; // già inviato
    try { await sendProposal(id, 'reminder'); }
    catch (err) { await releaseReminder(pool, id); throw err; } // invio fallito: si ritenta
  }));

  await b.work<IdJob>(Q.afterDecline, safe(async ([job]) => {
    const id = job!.data.deliveryId;
    const d = await getDelivery(pool, id);
    if (d.status === 'out_of_area') { await sendOutOfArea(id); return; } // ci pensa l'operatore
    if (d.status !== 'to_reschedule') return;
    await sendRescheduleLink(id);
  }));

  await b.work<IdJob>(Q.afterConfirm, safe(async ([job]) => {
    await sendConfirmation(job!.data.deliveryId);
  }));

  await b.work<IdJob>(Q.askPin, safe(async ([job]) => {
    await sendPinQuestion(job!.data.deliveryId);
  }));

  // Vecchie scadenze messe in coda con i tempi fissi: ora decide il controllo di ogni minuto
  await b.work<ExpireJob>(Q.expire, async () => {});

  // Ogni minuto: solleciti e "Senza risposta" con i tempi attuali di ogni azienda (scheda Messaggi)
  await b.work(Q.timers, async () => {
    try {
      let sent = 0, expired = 0;
      for (const t of await activeTenantIds(pool)) {
        const { remind, expire } = await dueTimers(pool, t, await getTiming(pool, t));
        for (const id of remind) if (await b.send(Q.reminder, { deliveryId: id }, { ...retry, singletonKey: `reminder:${id}` })) sent++;
        for (const id of expire) {
          try { await markNoResponse(id); expired++; }
          catch (err) { if (!(err instanceof DomainError)) throw err; } // nel frattempo il cliente ha risposto
        }
      }
      if (new Date().getMinutes() % 5 === 0) await refreshPendingTemplates().catch((e) => console.warn('[modello WhatsApp]', e));
      if (sent || expired) console.log(`[solleciti] ${sent} solleciti in invio, ${expired} consegne senza risposta`);
    } catch (err) {
      console.error('[solleciti] controllo non riuscito:', err);
      throw err;
    }
  });
  await b.schedule(Q.timers, '* * * * *', {}, { tz: config.TIMEZONE });

  await b.work(Q.slots, async () => {
    for (const t of await activeTenantIds(pool)) {
      const r = await generateSlots(pool, t);
      if (r.overbooked.length) console.warn(`[slots] ambiente ${t}: ${r.overbooked.length} slot oltre capienza`);
    }
  });
  await b.schedule(Q.slots, '15 2 * * *', {}, { tz: config.TIMEZONE });

  // Report Excel: ogni minuto controlla quali ambienti hanno superato le ore impostate o l'orario fisso
  await b.work(Q.reports, async () => {
    try {
      const gone = await purgeExpiredReports(pool);
      if (gone) console.log(`[report] cancellati ${gone} report più vecchi di 48 ore`);
      const n = await runDueReports(pool, await activeTenantIds(pool));
      if (n) console.log(`[report] generati ${n} report`);
    } catch (err) {
      console.error('[report] controllo periodico non riuscito:', err);
      throw err;
    }
  });
  await b.schedule(Q.reports, '* * * * *', {}, { tz: config.TIMEZONE });
}
