import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { clearSessionCookie, login, logout, readCookie, sessionOperator, setSessionCookie } from '../lib/auth.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const page = (name: string) => readFile(path.join(publicDir, name), 'utf8');

/** Login operatori e pagine del pannello. */
export async function sessionRoutes(app: FastifyInstance) {
  // Tentativi di accesso: limite semplice in memoria per IP
  const attempts = new Map<string, { n: number; until: number }>();

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip, now = Date.now(), a = attempts.get(ip);
    if (a && a.until > now && a.n >= 8) return reply.code(429).send({ error: 'too_many', message: 'Troppi tentativi. Riprova tra qualche minuto.' });
    const { email, password } = z.object({ email: z.string().min(3), password: z.string().min(1) }).parse(req.body);
    const r = await login(email, password);
    if (!r) {
      attempts.set(ip, { n: (a && a.until > now ? a.n : 0) + 1, until: now + 10 * 60_000 });
      return reply.code(401).send({ error: 'invalid_login', message: 'Email o password non corrette.' });
    }
    attempts.delete(ip);
    setSessionCookie(reply, r.token);
    return { name: r.operator.name, email: r.operator.email };
  });

  app.post('/api/logout', async (req, reply) => {
    const t = readCookie(req);
    if (t) await logout(t);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const op = await sessionOperator(req);
    if (!op) return reply.code(401).send({ error: 'unauthorized' });
    return op;
  });

  const html = (reply: import('fastify').FastifyReply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY');

  app.get('/', async (req, reply) => {
    if (!(await sessionOperator(req))) return reply.redirect('/login');
    return html(reply).send(await page('panel.html'));
  });
  app.get('/login', async (_req, reply) => html(reply).send(await page('login.html')));
}
