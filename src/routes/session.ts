import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../lib/db.js';
import { clearSessionCookie, COOKIE, loginAdmin, loginTenant, logout, readCookie, sessionOperator, setSessionCookie } from '../lib/auth.js';
import { getTenantBySlug } from '../domain/tenants.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const page = (name: string) => readFile(path.join(publicDir, name), 'utf8');
const html = (reply: FastifyReply) =>
  reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY').header('X-Robots-Tag', 'noindex');
const itDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Limite semplice di tentativi di accesso, in memoria, per IP */
function limiter() {
  const attempts = new Map<string, { n: number; until: number }>();
  return {
    blocked(req: FastifyRequest) { const a = attempts.get(req.ip); return Boolean(a && a.until > Date.now() && a.n >= 8); },
    fail(req: FastifyRequest) { const a = attempts.get(req.ip), now = Date.now(); attempts.set(req.ip, { n: (a && a.until > now ? a.n : 0) + 1, until: now + 10 * 60_000 }); },
    ok(req: FastifyRequest) { attempts.delete(req.ip); },
  };
}

/** Pagine e accessi: /admin per te, /<ambiente> per ogni cliente. */
export async function sessionRoutes(app: FastifyInstance) {
  const lim = limiter();
  const tooMany = (reply: FastifyReply) => reply.code(429).send({ error: 'too_many', message: 'Troppi tentativi. Riprova tra qualche minuto.' });

  /* ---------- superamministratore ---------- */
  app.post('/api/admin/login', async (req, reply) => {
    if (lim.blocked(req)) return tooMany(reply);
    const { email, password } = z.object({ email: z.string().min(3), password: z.string().min(1) }).parse(req.body);
    const r = await loginAdmin(email, password);
    if (!r.ok) { lim.fail(req); return reply.code(401).send({ error: 'invalid_login', message: 'Email o password non corrette.' }); }
    lim.ok(req);
    setSessionCookie(reply, 'admin', r.token);
    return { name: r.operator.name };
  });
  app.post('/api/admin/logout', async (req, reply) => {
    const t = readCookie(req, COOKIE.admin);
    if (t) await logout(t);
    clearSessionCookie(reply, 'admin');
    return { ok: true };
  });
  app.get('/admin', async (req, reply) => {
    if (!(await sessionOperator(req, 'admin'))) return reply.redirect('/admin/login');
    return html(reply).send(await page('admin.html'));
  });
  app.get('/admin/login', async (_req, reply) => html(reply).send(await page('login.html')));
  app.get('/', async (_req, reply) => reply.redirect('/admin'));

  /* ---------- ambienti dei clienti ---------- */
  app.post('/api/login', async (req, reply) => {
    if (lim.blocked(req)) return tooMany(reply);
    const { tenant, username, password } = z.object({ tenant: z.string().min(1), username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const r = await loginTenant(tenant, username, password);
    if (!r.ok) {
      if (r.reason === 'invalid') { lim.fail(req); return reply.code(401).send({ error: 'invalid_login', message: 'Utente o password non corretti.' }); }
      lim.ok(req);
      return reply.code(403).send(r.reason === 'expired'
        ? { error: 'expired', message: `L'abbonamento è scaduto il ${itDate(r.until!)}. Contatta il fornitore del servizio per rinnovarlo.` }
        : { error: 'suspended', message: "L'accesso a questo ambiente è sospeso. Contatta il fornitore del servizio." });
    }
    lim.ok(req);
    setSessionCookie(reply, 'tenant', r.token);
    return { slug: r.operator.tenant_slug };
  });
  app.post('/api/logout', async (req, reply) => {
    const t = readCookie(req, COOKIE.tenant);
    if (t) await logout(t);
    clearSessionCookie(reply, 'tenant');
    return { ok: true };
  });
  app.get('/api/me', async (req, reply) => {
    const op = await sessionOperator(req, 'tenant');
    if (!op) return reply.code(401).send({ error: 'unauthorized' });
    return { username: op.username, name: op.name, email: op.email, tenant: op.tenant_slug, tenant_name: op.tenant_name, subscription_end: op.subscription_end };
  });
  /** Nome dell'ambiente per la pagina di accesso (nient'altro è pubblico) */
  app.get('/api/tenant/:slug', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const t = await getTenantBySlug(pool, slug);
    if (!t) return reply.code(404).send({ error: 'not_found', message: 'Ambiente non trovato.' });
    return { name: t.name };
  });

  const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/) });
  const notFoundPage = (reply: FastifyReply) => html(reply).code(404).send('<!doctype html><meta charset="utf-8"><title>Pagina non trovata</title><p style="font-family:system-ui;padding:24px">Pagina non trovata.</p>');

  app.get('/:slug/login', async (req, reply) => {
    const p = slugParam.safeParse(req.params);
    if (!p.success || !(await getTenantBySlug(pool, p.data.slug))) return notFoundPage(reply);
    return html(reply).send(await page('login.html'));
  });
  app.get('/:slug', async (req, reply) => reply.redirect(`/${(req.params as { slug: string }).slug}/`));
  app.get('/:slug/', async (req, reply) => {
    const p = slugParam.safeParse(req.params);
    if (!p.success || !(await getTenantBySlug(pool, p.data.slug))) return notFoundPage(reply);
    const op = await sessionOperator(req, 'tenant');
    if (!op || op.tenant_slug !== p.data.slug) return reply.redirect(`/${p.data.slug}/login`);
    return html(reply).send(await page('panel.html'));
  });
}
