import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { config } from '../config.js';
import { addDays } from '../lib/dates.js';
import { linkExpired } from '../lib/errors.js';

const hash = (token: string) => createHash('sha256').update(token).digest();

/**
 * Crea un link personale. Il token in chiaro va solo nel messaggio al cliente;
 * nel database resta l'hash. Scade il giorno dopo la consegna, al massimo dopo TOKEN_MAX_DAYS.
 */
export async function createToken(db: Db, deliveryId: string, deliveryDate: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const byDelivery = new Date(`${addDays(deliveryDate, 1)}T00:00:00Z`);
  const byMax = new Date(Date.now() + config.TOKEN_MAX_DAYS * 864e5);
  await db.query('INSERT INTO access_tokens (delivery_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    deliveryId,
    hash(token),
    byDelivery < byMax ? byDelivery : byMax,
  ]);
  return token;
}

/** Restituisce l'id della consegna o lancia link_expired. */
export async function resolveToken(db: Db, token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw linkExpired();
  const r = await db.query<{ delivery_id: string }>(
    'SELECT delivery_id FROM access_tokens WHERE token_hash = $1 AND expires_at > now()',
    [hash(token)],
  );
  if (!r.rows[0]) throw linkExpired();
  return r.rows[0].delivery_id;
}

export async function extendToken(db: Db, deliveryId: string, newDeliveryDate: string) {
  await db.query('UPDATE access_tokens SET expires_at = GREATEST(expires_at, $2) WHERE delivery_id = $1', [
    deliveryId,
    new Date(`${addDays(newDeliveryDate, 1)}T00:00:00Z`),
  ]);
}

export const customerUrl = (token: string) => `${config.PUBLIC_BASE_URL}/r/${token}`;
