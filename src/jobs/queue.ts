import PgBoss from 'pg-boss';
import { config } from '../config.js';
import { pool } from '../lib/db.js';
import { getDelivery, incrementReminders, markNoResponse, type Status } from '../domain/deliveries.js';
import { activeTenantIds, generateSlots } from '../domain/slots.js';
import { sendConfirmation, sendOutOfArea, sendProposal, sendRescheduleLink } from '../notify/notifier.js';

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

const hours = (h: number) => Math.round(h * 3600);
const retry = { retryLimit: 5, retryDelay: 60, retryBackoff: true };

function q() {
  if (!boss) throw new Error('Coda non avviata');
  return boss;
}

export const enqueue = {
  proposal: (deliveryId: string) => q().send(Q.proposal, { deliveryId }, { ...retry, singletonKey: `proposal:${deliveryId}` }),
  afterDecline: (deliveryId: string) => q().send(Q.afterDecline, { deliveryId }, retry),
  afterConfirm: (deliveryId: string) => q().send(Q.afterConfirm, { deliveryId }, retry),
};

async function registerWorkers(b: PgBoss) {
  await b.work<IdJob>(Q.proposal, async ([job]) => {
    const id = job!.data.deliveryId;
    await sendProposal(id, 'proposal');
    await b.send(Q.reminder, { deliveryId: id }, { ...retry, startAfter: hours(config.REMINDER_AFTER_HOURS) });
  });

  await b.work<IdJob>(Q.reminder, async ([job]) => {
    const id = job!.data.deliveryId;
    const d = await getDelivery(pool, id);
    if (d.status !== 'proposed') return;
    await sendProposal(id, 'reminder');
    await incrementReminders(id);
    const wait = Math.max(config.NO_RESPONSE_AFTER_HOURS - config.REMINDER_AFTER_HOURS, 1);
    await b.send(Q.expire, { deliveryId: id, ifStatus: 'proposed' } satisfies ExpireJob, { startAfter: hours(wait) });
  });

  await b.work<IdJob>(Q.afterDecline, async ([job]) => {
    const id = job!.data.deliveryId;
    const d = await getDelivery(pool, id);
    if (d.status === 'out_of_area') { await sendOutOfArea(id); return; } // ci pensa l'operatore
    if (d.status !== 'to_reschedule') return;
    await sendRescheduleLink(id);
    await b.send(Q.expire, { deliveryId: id, ifStatus: 'to_reschedule' } satisfies ExpireJob, { startAfter: hours(config.NO_RESPONSE_AFTER_HOURS) });
  });

  await b.work<IdJob>(Q.afterConfirm, async ([job]) => {
    await sendConfirmation(job!.data.deliveryId);
  });

  // Scade solo se la consegna è ancora nello stato in cui era quando il job è stato creato
  await b.work<ExpireJob>(Q.expire, async ([job]) => {
    const { deliveryId, ifStatus } = job!.data;
    const d = await getDelivery(pool, deliveryId);
    if (d.status === ifStatus) await markNoResponse(deliveryId);
  });

  await b.work(Q.slots, async () => {
    for (const t of await activeTenantIds(pool)) {
      const r = await generateSlots(pool, t);
      if (r.overbooked.length) console.warn(`[slots] ambiente ${t}: ${r.overbooked.length} slot oltre capienza`);
    }
  });
  await b.schedule(Q.slots, '15 2 * * *', {}, { tz: config.TIMEZONE });
}
