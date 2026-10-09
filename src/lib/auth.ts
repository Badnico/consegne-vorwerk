import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from './db.js';
import { todayLocal } from './dates.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 14;
/** Due cookie distinti: puoi essere dentro come amministratore e come cliente nello stesso browser */
export const COOKIE = { tenant: 'sid', admin: 'asid' } as const;
type Kind = keyof typeof COOKIE;

export interface Operator {
  id: string;
  username: string;
  email: string;
  name: string;
  role: 'superadmin' | 'admin' | 'operator';
  tenant_id: string | null;
  tenant_slug: string | null;
  tenant_name: string | null;
  subscription_end: string | null;
}

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
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha = (t: string) => createHash('sha256').update(t).digest();
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88);

/**
 * Al primo avvio crea il superamministratore (tu) da ADMIN_EMAIL e ADMIN_PASSWORD.
 * In locale, senza variabili, crea un utente di prova e lo scrive nel log.
 */
/**
 * Superamministratore da ADMIN_EMAIL / ADMIN_PASSWORD (variabili su Render).
 * A ogni avvio: se l'utente con quell'email non c'è lo crea, se la password è cambiata la aggiorna.
 * Così, se dimentichi la password, basta cambiarla su Render e riavviare.
 */
export async function ensureAdmin(log: (m: string) => void) {
  let email = config.ADMIN_EMAIL?.trim().toLowerCase(), password = config.ADMIN_PASSWORD;
  if (!email || !password) {
    const n = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operators WHERE role = 'superadmin'`)).rows[0]!.n;
    if (n > 0) return;
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
      log('ATTENZIONE: ADMIN_EMAIL/ADMIN_PASSWORD non impostati: impossibile accedere a /admin.');
      return;
    }
    email = 'admin@example.it';
    password = 'consegne-locale';
    log(`Superamministratore di prova: ${email} / ${password} (solo in locale)`);
  }
  const r = await pool.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM operators WHERE role = 'superadmin' AND lower(email) = $1`, [email],
  );
  const row = r.rows[0];
  if (!row) {
    await pool.query(`INSERT INTO operators (email, username, name, password_hash, role) VALUES ($1, $1, $2, $3, 'superadmin')`, [
      email, 'Amministratore', await hashPassword(password),
    ]);
    log(`Superamministratore creato: ${email}`);
  } else if (!(await verifyPassword(password, row.password_hash))) {
    await pool.query('UPDATE operators SET password_hash = $1 WHERE id = $2', [await hashPassword(password), row.id]);
    await pool.query('DELETE FROM sessions WHERE operator_id = $1', [row.id]);
    log(`Password del superamministratore ${email} aggiornata da ADMIN_PASSWORD`);
  }
}

export type LoginResult =
  | { ok: true; token: string; operator: Operator }
  | { ok: false; reason: 'invalid' | 'expired' | 'suspended'; until?: string };

const OP_SQL = `
  SELECT o.id, o.username, o.email, o.name, o.role, o.tenant_id, o.password_hash,
         t.slug AS tenant_slug, t.name AS tenant_name, t.subscription_end, t.suspended
    FROM operators o LEFT JOIN tenants t ON t.id = o.tenant_id`;

async function startSession(operatorId: string) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), operatorId]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return token;
}
const strip = ({ password_hash: _h, suspended: _s, ...op }: Operator & { password_hash: string; suspended: boolean | null }) => op as Operator;

/** Accesso all'ambiente di un cliente: utente + password, bloccato se l'abbonamento è scaduto o sospeso. */
export async function loginTenant(slug: string, username: string, password: string): Promise<LoginResult> {
  const r = await pool.query<Operator & { password_hash: string; suspended: boolean }>(
    `${OP_SQL} WHERE t.slug = $1 AND lower(o.username) = lower($2)`,
    [slug.toLowerCase(), username.trim()],
  );
  const row = r.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return { ok: false, reason: 'invalid' };
  if (row.suspended) return { ok: false, reason: 'suspended' };
  if (row.subscription_end! < todayLocal()) return { ok: false, reason: 'expired', until: row.subscription_end! };
  return { ok: true, token: await startSession(row.id), operator: strip(row) };
}

/** Accesso del superamministratore: email + password. */
export async function loginAdmin(email: string, password: string): Promise<LoginResult> {
  const r = await pool.query<Operator & { password_hash: string; suspended: boolean }>(
    `${OP_SQL} WHERE o.role = 'superadmin' AND lower(o.email) = lower($1)`,
    [email.trim()],
  );
  const row = r.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return { ok: false, reason: 'invalid' };
  return { ok: true, token: await startSession(row.id), operator: strip(row) };
}

export async function logout(token: string) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Operatore della sessione. Per gli ambienti dei clienti l'abbonamento viene ricontrollato a ogni richiesta:
 * appena scade (o viene sospeso) l'accesso si chiude anche per chi è già dentro.
 */
export async function sessionOperator(req: FastifyRequest, kind: Kind): Promise<Operator | null> {
  const token = readCookie(req, COOKIE[kind]);
  if (!token) return null;
  const r = await pool.query<Operator & { password_hash: string; suspended: boolean }>(
    `${OP_SQL} JOIN sessions s ON s.operator_id = o.id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (kind === 'admin') return row.role === 'superadmin' ? strip(row) : null;
  if (!row.tenant_id || row.suspended || row.subscription_end! < todayLocal()) return null;
  return strip(row);
}

const secure = () => config.PUBLIC_BASE_URL.startsWith('https://');
export function setSessionCookie(reply: FastifyReply, kind: Kind, token: string) {
  reply.header('Set-Cookie', `${COOKIE[kind]}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure() ? '; Secure' : ''}`);
}
export function clearSessionCookie(reply: FastifyReply, kind: Kind) {
  reply.header('Set-Cookie', `${COOKIE[kind]}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`);
}

/** Le richieste che modificano dati devono arrivare da una pagina dello stesso sito. */
function sameOrigin(req: FastifyRequest) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin ?? req.headers.referer;
  try { return Boolean(origin) && new URL(origin!).host === req.headers.host; } catch { return false; }
}

type WithOp = FastifyRequest & { operator?: Operator };

/** API del pannello di un ambiente: sessione valida e abbonamento attivo. */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  const op = await sessionOperator(req, 'tenant');
  if (!op) return reply.code(401).send({ error: 'unauthorized', message: 'Accesso richiesto o abbonamento non attivo.' });
  if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden', message: 'Richiesta non consentita.' });
  (req as WithOp).operator = op;
}

/** API del superamministratore. */
export async function requireSuperadmin(req: FastifyRequest, reply: FastifyReply) {
  const op = await sessionOperator(req, 'admin');
  if (!op) return reply.code(401).send({ error: 'unauthorized', message: 'Accesso richiesto.' });
  if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden', message: 'Richiesta non consentita.' });
  (req as WithOp).operator = op;
}

export const operatorOf = (req: FastifyRequest) => (req as WithOp).operator!;
export const tenantOf = (req: FastifyRequest) => (req as WithOp).operator!.tenant_id!;
export const actorOf = (req: FastifyRequest) => `operator:${(req as WithOp).operator?.username ?? '?'}`;
