import Fastify from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from './lib/errors.js';
import { customerRoutes } from './routes/customer.js';
import { webhookRoutes } from './routes/webhooks.js';
import { panelRoutes } from './routes/panel.js';
import { sessionRoutes } from './routes/session.js';
import { superadminRoutes } from './routes/superadmin.js';
import { pool } from './lib/db.js';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // I token dei link sono nel percorso: non finiscono nei log
      serializers: { req: (req) => ({ method: req.method, url: req.url.replace(/\/r\/[^/?]+/, '/r/***') }) },
    },
    trustProxy: true,
  });

  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(422).send({ error: 'invalid_input', message: err.issues.map((i) => i.message).join('; '), issues: err.issues });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Errore interno. Riprova tra poco.' });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.register(sessionRoutes);
  app.register(panelRoutes, { prefix: '/api/panel' });
  app.register(superadminRoutes, { prefix: '/api/admin' });
  app.register(customerRoutes);
  app.register(webhookRoutes);
  return app;
}
