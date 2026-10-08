import { pool, tx, type Db } from '../lib/db.js';
import { DomainError, notFound } from '../lib/errors.js';
import { todayLocal } from '../lib/dates.js';
import { hashPassword } from '../lib/auth.js';
import { ensureDefaultTemplates, generateSlots } from './slots.js';

/** Un ambiente = un cliente che usa il servizio, con il suo indirizzo /slug e i suoi dati separati. */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  email: string;
  subscription_end: string;
  suspended: boolean;
  created_at: string;
}

export interface TenantRow extends Tenant {
  username: string | null;
  deliveries: number;
  active_deliveries: number;
  last_login: string | null;
}

/** Indirizzi che non possono diventare nomi di ambiente perché usati dal sistema */
const RESERVED = new Set(['admin', 'api', 'r', 'login', 'logout', 'health', 'webhooks', 'static', 'assets', 'public', 'app', 'www']);

export function slugify(name: string) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function checkSlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new DomainError('invalid_slug', "L'indirizzo deve avere 3–40 caratteri: lettere minuscole, numeri e trattini, senza trattino all'inizio o alla fine.", 422);
  }
  if (RESERVED.has(slug)) throw new DomainError('reserved_slug', `"${slug}" è riservato dal sistema: scegline un altro.`, 422);
}

export function checkPassword(pw: string) {
  if (pw.length < 10) throw new DomainError('weak_password', 'La password deve avere almeno 10 caratteri.', 422);
}

/** Stato di accesso: attivo, sospeso o scaduto */
export function accessState(t: Pick<Tenant, 'suspended' | 'subscription_end'>): 'active' | 'suspended' | 'expired' {
  if (t.suspended) return 'suspended';
  return t.subscription_end >= todayLocal() ? 'active' : 'expired';
}

export async function getTenantBySlug(db: Db, slug: string): Promise<Tenant | null> {
  const r = await db.query<Tenant>('SELECT id, slug, name, email, subscription_end, suspended, created_at FROM tenants WHERE slug = $1', [slug.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function listTenants(): Promise<TenantRow[]> {
  const r = await pool.query<TenantRow>(`
    SELECT t.id, t.slug, t.name, t.email, t.subscription_end, t.suspended, t.created_at,
           (SELECT o.username FROM operators o WHERE o.tenant_id = t.id ORDER BY o.created_at LIMIT 1) AS username,
           (SELECT count(*)::int FROM deliveries d WHERE d.tenant_id = t.id) AS deliveries,
           (SELECT count(*)::int FROM deliveries d WHERE d.tenant_id = t.id AND d.status NOT IN ('delivered','cancelled')) AS active_deliveries,
           (SELECT max(s.created_at) FROM sessions s JOIN operators o ON o.id = s.operator_id WHERE o.tenant_id = t.id) AS last_login
      FROM tenants t ORDER BY t.created_at DESC`);
  return r.rows;
}

export interface NewTenant { name: string; slug: string; username: string; password: string; email: string; subscription_end: string }

/** Crea ambiente, utente e fasce standard; genera subito gli slot. */
export async function createTenant(input: NewTenant): Promise<string> {
  checkSlug(input.slug);
  checkPassword(input.password);
  const hash = await hashPassword(input.password);
  return tx(async (c) => {
    if ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug])).rowCount) {
      throw new DomainError('slug_taken', `L'indirizzo /${input.slug} è già usato da un altro ambiente.`, 409);
    }
    const t = await c.query<{ id: string }>(
      'INSERT INTO tenants (slug, name, email, subscription_end) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.slug, input.name, input.email, input.subscription_end],
    );
    const id = t.rows[0]!.id;
    await c.query(
      `INSERT INTO operators (tenant_id, username, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [id, input.username.trim(), input.email, input.name, hash],
    );
    await ensureDefaultTemplates(c, id);
    await generateSlots(c, id);
    return id;
  });
}

export interface TenantPatch { name?: string; email?: string; subscription_end?: string; suspended?: boolean; username?: string; password?: string }

export async function updateTenant(id: string, p: TenantPatch) {
  if (p.password !== undefined) checkPassword(p.password);
  const hash = p.password !== undefined ? await hashPassword(p.password) : null;
  return tx(async (c) => {
    const cur = await c.query<Tenant>('SELECT * FROM tenants WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw notFound('Ambiente');
    await c.query(
      `UPDATE tenants SET name = COALESCE($2, name), email = COALESCE($3, email),
              subscription_end = COALESCE($4, subscription_end), suspended = COALESCE($5, suspended) WHERE id = $1`,
      [id, p.name ?? null, p.email ?? null, p.subscription_end ?? null, p.suspended ?? null],
    );
    const op = await c.query<{ id: string }>('SELECT id FROM operators WHERE tenant_id = $1 ORDER BY created_at LIMIT 1', [id]);
    const opId = op.rows[0]?.id;
    if (!opId && (p.username || hash)) {
      // Ambiente senza utente (es. dati migrati dalla versione precedente): lo crea
      if (!p.username || !hash) throw new DomainError('missing_user', 'Per creare l\'utente servono sia nome utente sia password.', 422);
      const t = cur.rows[0];
      await c.query(`INSERT INTO operators (tenant_id, username, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')`,
        [id, p.username.trim(), p.email ?? t.email, p.name ?? t.name, hash]);
    }
    if (opId) {
      await c.query(
        `UPDATE operators SET username = COALESCE($2, username), email = COALESCE($3, email),
                password_hash = COALESCE($4, password_hash) WHERE id = $1`,
        [opId, p.username?.trim() || null, p.email ?? null, hash],
      );
      // Password cambiata o accesso bloccato: chi era dentro deve rientrare
      if (hash || p.suspended) await c.query('DELETE FROM sessions WHERE operator_id IN (SELECT id FROM operators WHERE tenant_id = $1)', [id]);
    }
    // Riattivato o rinnovato: gli slot riprendono da oggi
    if (p.subscription_end !== undefined || p.suspended === false) await generateSlots(c, id);
  });
}

export async function deleteTenant(id: string) {
  const r = await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('Ambiente');
}
