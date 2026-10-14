import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../lib/db.js';
import { DomainError } from '../lib/errors.js';
import { answerPin, confirmDelivery, declineDelivery } from '../domain/deliveries.js';
import { verifySignature, type WaWebhook } from '../notify/whatsapp.js';
import { enqueue } from '../jobs/queue.js';
import { tenantsByPhoneNumberId } from '../domain/settings.js';
import { findDeliveryForPhone, inboundText } from '../domain/inbox.js';
import { sendAlreadyAnswered } from '../notify/notifier.js';

/** Ultime chiamate di Meta per numero (in memoria): per capire dall'admin se le risposte arrivano. */
export const webhookSeen = new Map<string, { at: string; ok: boolean }>();

/** Registra un messaggio in entrata; false se già visto (Meta può consegnare lo stesso evento più volte). */
async function recordInbound(deliveryId: string | null, providerId: string, payload: unknown, kind: 'reply' | 'text', body: string) {
  const r = await pool.query(
    `INSERT INTO messages (delivery_id, channel, direction, kind, provider_id, status, payload, body)
     VALUES ($1, 'whatsapp', 'in', $4, $2, 'received', $3, $5) ON CONFLICT (provider_id) DO NOTHING RETURNING id`,
    [deliveryId, providerId, JSON.stringify(payload), kind, body],
  );
  return r.rowCount === 1;
}

async function handleReply(payload: string) {
  const m = /^(YES|NO|PINYES|PINNO):([0-9a-f-]{36})$/i.exec(payload);
  if (!m) return null;
  const [, answer, deliveryId] = m as unknown as [string, string, string];
  try {
    const a = answer.toUpperCase();
    if (a === 'YES') {
      const st = await confirmDelivery(deliveryId, 'customer:whatsapp');
      if (st === 'pin_check') await enqueue.askPin(deliveryId); // prima la domanda sul PIN
      else await enqueue.afterConfirm(deliveryId);
    } else if (a === 'PINYES' || a === 'PINNO') {
      const st = await answerPin(deliveryId, a === 'PINYES', 'customer:whatsapp');
      if (st === 'confirmed') await enqueue.afterConfirm(deliveryId);
      else await enqueue.afterDecline(deliveryId); // messaggio "fuori area": lo richiama un operatore
    } else {
      await declineDelivery(deliveryId, 'customer:whatsapp');
      await enqueue.afterDecline(deliveryId);
    }
  } catch (err) {
    // Risposta arrivata in uno stato che non la ammette (es. Sì dopo No): si ignora e si avvisa il cliente
    if (!(err instanceof DomainError)) throw err;
    await sendAlreadyAnswered(deliveryId).catch(() => {});
  }
  return deliveryId;
}

export async function webhookRoutes(app: FastifyInstance) {
  // Corpo grezzo: serve per verificare la firma HMAC
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Verifica iniziale richiesta da Meta quando si registra il webhook
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && config.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === config.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = req.body as Buffer;
    let body: WaWebhook;
    try { body = JSON.parse(raw.toString('utf8')) as WaWebhook; } catch { return reply.code(400).send(); }
    // firma: con la chiave generale o, se il numero è di un cliente su un altro account Meta, con la sua
    const phoneId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const secrets = [config.WHATSAPP_APP_SECRET, ...(phoneId ? (await tenantsByPhoneNumberId(pool, phoneId)).map((r) => r.value.appSecret) : [])];
    const okSig = verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, secrets);
    if (phoneId) webhookSeen.set(phoneId, { at: new Date().toISOString(), ok: okSig });
    if (!okSig) { req.log.warn({ phoneId }, 'webhook WhatsApp con firma non valida: controlla la chiave segreta dell\'app (App secret)'); return reply.code(401).send(); }

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        for (const msg of v.messages ?? []) {
          const payload = msg.button?.payload ?? msg.interactive?.button_reply?.id ?? null;
          const fromPayload = payload ? /:([0-9a-f-]{36})$/i.exec(payload)?.[1] ?? null : null;
          // pulsante: la consegna è nel payload; testo, foto, vocali: si cerca dal numero del cliente
          const deliveryId = fromPayload ?? (await findDeliveryForPhone(pool, msg.from, v.metadata?.phone_number_id));
          if (!(await recordInbound(deliveryId, msg.id, msg, fromPayload ? 'reply' : 'text', inboundText(msg)))) continue; // duplicato
          if (payload) await handleReply(payload);
        }
        for (const st of v.statuses ?? []) {
          await pool.query('UPDATE messages SET status = $2, updated_at = now() WHERE provider_id = $1', [st.id, st.status]);
          // TODO: su "failed" della proposta, accodare il ripiego via email
        }
      }
    }
    // Meta vuole 200 in fretta: il lavoro pesante va in coda
    return reply.code(200).send();
  });

  /** Rimbalzi e reclami dal provider email: il formato dipende dal provider scelto */
  app.post('/webhooks/email', async (_req, reply) => reply.code(204).send());
}
