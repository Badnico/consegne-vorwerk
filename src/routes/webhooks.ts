import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../lib/db.js';
import { DomainError } from '../lib/errors.js';
import { confirmDelivery, declineDelivery } from '../domain/deliveries.js';
import { verifySignature, type WaWebhook } from '../notify/whatsapp.js';
import { enqueue } from '../jobs/queue.js';

/** Registra un messaggio in entrata; false se già visto (Meta può consegnare lo stesso evento più volte). */
async function recordInbound(deliveryId: string | null, providerId: string, payload: unknown) {
  const r = await pool.query(
    `INSERT INTO messages (delivery_id, channel, direction, kind, provider_id, status, payload)
     VALUES ($1, 'whatsapp', 'in', 'reply', $2, 'received', $3) ON CONFLICT (provider_id) DO NOTHING RETURNING id`,
    [deliveryId, providerId, JSON.stringify(payload)],
  );
  return r.rowCount === 1;
}

async function handleReply(payload: string) {
  const m = /^(YES|NO):([0-9a-f-]{36})$/i.exec(payload);
  if (!m) return null;
  const [, answer, deliveryId] = m as unknown as [string, string, string];
  try {
    if (answer.toUpperCase() === 'YES') {
      await confirmDelivery(deliveryId, 'customer:whatsapp');
      await enqueue.afterConfirm(deliveryId);
    } else {
      await declineDelivery(deliveryId, 'customer:whatsapp');
      await enqueue.afterDecline(deliveryId);
    }
  } catch (err) {
    // Risposta arrivata in uno stato che non la ammette (es. doppio tocco): si ignora, resta nel log
    if (!(err instanceof DomainError)) throw err;
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
    if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) return reply.code(401).send();
    const body = JSON.parse(raw.toString('utf8')) as WaWebhook;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        for (const msg of v.messages ?? []) {
          const payload = msg.button?.payload ?? msg.interactive?.button_reply?.id ?? null;
          const deliveryId = payload ? /:(.+)$/.exec(payload)?.[1] ?? null : null;
          if (!(await recordInbound(deliveryId, msg.id, msg))) continue; // duplicato
          if (payload) await handleReply(payload);
          // Testo libero del cliente: resta in "messages" e va mostrato all'operatore (TODO pannello)
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
