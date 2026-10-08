import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperadmin } from '../lib/auth.js';
import { accessState, createTenant, deleteTenant, listTenants, slugify, updateTenant } from '../domain/tenants.js';
import { DomainError } from '../lib/errors.js';
import { config } from '../config.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida');

/** API del pannello amministratore: gestione degli ambienti dei clienti. */
export async function superadminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/admin/login') || req.url.startsWith('/api/admin/logout')) return;
    return requireSuperadmin(req, reply);
  });

  app.get('/tenants', async () => ({
    base: config.PUBLIC_BASE_URL,
    tenants: (await listTenants()).map((t) => ({ ...t, state: accessState(t) })),
  }));

  app.get('/slug', async (req) => ({ slug: slugify(z.object({ name: z.string() }).parse(req.query).name) }));

  app.post('/tenants', async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(2, "Inserisci il nome dell'azienda").max(120),
      slug: z.string().trim().toLowerCase(),
      username: z.string().trim().min(3, "L'utente deve avere almeno 3 caratteri").max(60),
      password: z.string().min(10, 'La password deve avere almeno 10 caratteri').max(200),
      email: z.string().trim().email('Email non valida'),
      subscription_end: isoDate,
    }).parse(req.body);
    const id = await createTenant(b);
    return reply.code(201).send({ id });
  });

  app.patch('/tenants/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().email('Email non valida').optional(),
      subscription_end: isoDate.optional(),
      suspended: z.boolean().optional(),
      username: z.string().trim().min(3, "L'utente deve avere almeno 3 caratteri").max(60).optional(),
      password: z.string().min(10, 'La password deve avere almeno 10 caratteri').max(200).optional(),
    }).parse(req.body);
    await updateTenant(id, b);
    return { ok: true };
  });

  app.delete('/tenants/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    const t = (await listTenants()).find((x) => x.id === id);
    if (!t) throw new DomainError('not_found', 'Ambiente non trovato.', 404);
    if (confirm !== t.slug) throw new DomainError('confirm_mismatch', `Per eliminare scrivi esattamente "${t.slug}".`, 422);
    await deleteTenant(id);
    return { ok: true };
  });
}
