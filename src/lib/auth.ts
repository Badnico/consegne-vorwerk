import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 14;
export const COOKIE = 'sid';

export interface Operator { id: string; email: string; name: string; role: 'admin' | 'operator' }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, salt, key] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(got, expected);
}

const sha = (t: string) => createHash('sha256').update(t).digest();

/**
 * Al primo avvio crea l'amministratore da ADMIN_EMAIL e ADMIN_PASSWORD.
 * In locale, senza variabili, crea un utente di prova e lo scrive nel log.
 */
export async function ensureAdmin(log: (m: string) => void) {
  const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM operators')).rows[0]!.n;
  if (n > 0) return;
  let email = config.ADMIN_EMAIL, password = config.ADMIN_PASSWORD;
  if (!email || !password) {
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
      log('ATTENZIONE: nessun operatore e ADMIN_EMAIL/ADMIN_PASSWORD non impostati: impossibile accedere al pannello.');
      return;
    }
    email = 'admin@example.it';
    password = 'consegne-locale';
    log(`Utente di prova creato: ${email} / ${password} (solo in locale)`);
  }
  await pool.query('INSERT INTO operators (email, name, password_hash, role) VALUES ($1, $2, $3, $4)', [
    email.toLowerCase(), 'Amministratore', await hashPassword(password), 'admin',
  ]);
  log(`Amministratore creato: ${email}`);
}

export async function login(email: string, password: string): Promise<{ token: string; operator: Operator } | null> {
  const r = await pool.query<Operator & { password_hash: string }>(
    'SELECT id, email, name, role, password_hash FROM operators WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const row = r.rows[0];
  // Verifica comunque una password per non rivelare, dai tempi di risposta, se l'email esiste
  const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88));
  if (!row || !ok) return null;
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), row.id]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, operator: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

export async function logout(token: string) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export function readCookie(req: FastifyRequest, name = COOKIE): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function sessionOperator(req: FastifyRequest): Promise<Operator | null> {
  const token = readCookie(req);
  if (!token) return null;
  const r = await pool.query<Operator>(
    `SELECT o.id, o.email, o.name, o.role FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)],
  );
  return r.rows[0] ?? null;
}

const secure = () => config.PUBLIC_BASE_URL.startsWith('https://');
export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure() ? '; Secure' : ''}`);
}
export function clearSessionCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`);
}

function apiKeyOk(header: string | undefined) {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.ADMIN_API_KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Accesso alle API operatori: sessione del pannello oppure chiave API (per integrazioni, es. import da Vorwerk).
 * Per le richieste che modificano dati con la sessione, l'origine deve essere lo stesso sito.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  if (apiKeyOk(req.headers.authorization)) { (req as FastifyRequest & { operator?: Operator }).operator = { id: 'api', email: 'api', name: 'API', role: 'admin' }; return; }
  const op = await sessionOperator(req);
  if (!op) return reply.code(401).send({ error: 'unauthorized', message: 'Accesso richiesto.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin ?? req.headers.referer;
    let host: string | null = null;
    try { host = origin ? new URL(origin).host : null; } catch { host = null; }
    if (!host || host !== req.headers.host) return reply.code(403).send({ error: 'forbidden', message: 'Richiesta non consentita.' });
  }
  (req as FastifyRequest & { operator?: Operator }).operator = op;
}

export const actorOf = (req: FastifyRequest) => `operator:${(req as FastifyRequest & { operator?: Operator }).operator?.email ?? '?'}`;
