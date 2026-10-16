import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperadmin } from '../lib/auth.js';
import { accessState, createTenant, deleteTenant, listTenants, slugify, updateTenant } from '../domain/tenants.js';
import { DomainError } from '../lib/errors.js';
import { config } from '../config.js';
import { pool } from '../lib/db.js';
import { getWaSetting, saveWaSetting } from '../domain/settings.js';
import { waConfigFor } from '../notify/notifier.js';
import * as wa from '../notify/whatsapp.js';
import { normalizePhone } from '../domain/importer.js';
import { createBackup } from '../domain/backup.js';
import { webhookSeen } from './webhooks.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida');

/** API del pannello amministratore: gestione degli ambienti dei clienti. */
export async function superadminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/admin/login') || req.url.startsWith('/api/admin/logout')) return;
    return requireSuperadmin(req, reply);
  });

  /** Backup completo di tutti i dati (tutti i clienti) in un file da scaricare. */
  app.get('/backup', async (_req, reply) => {
    const b = await createBackup();
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${b.name}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(b.file);
  });

  app.get('/tenants', async () => {
    const tenants = await listTenants();
    return {
      base: config.PUBLIC_BASE_URL,
      globalWhatsapp: Boolean(wa.globalWaConfig()),
      tenants: await Promise.all(tenants.map(async (t) => {
        const w = await getWaSetting(pool, t.id);
        // le chiavi non tornano mai al browser: solo se sono impostate
        return { ...t, state: accessState(t), whatsapp: { phoneNumberId: w.phoneNumberId, template: w.template, lang: w.lang, hasToken: Boolean(w.token), hasSecret: Boolean(w.appSecret) } };
      })),
    };
  });

  /** Numero WhatsApp del cliente. token/appSecret vuoti = lascia quelli salvati; clear = torna al numero generale. */
  app.put('/tenants/:id/whatsapp', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      phoneNumberId: z.string().trim().regex(/^(\d{6,20})?$/, "L'ID del numero è fatto solo di cifre (lo trovi su Meta in WhatsApp → Configurazione API)"),
      token: z.string().trim().max(1000).optional().default(''),
      appSecret: z.string().trim().max(200).optional().default(''),
      template: z.string().trim().regex(/^[a-z0-9_]*$/, 'Il nome del modello ha solo lettere minuscole, numeri e _').max(100).optional().default(''),
      lang: z.string().trim().max(10).optional().default(''),
      clear: z.boolean().optional().default(false),
    }).parse(req.body);
    const cur = await getWaSetting(pool, id);
    const next = b.clear || !b.phoneNumberId
      ? { phoneNumberId: '', token: '', appSecret: '', template: '', lang: '' }
      : { phoneNumberId: b.phoneNumberId, token: b.token || cur.token, appSecret: b.appSecret || cur.appSecret, template: b.template, lang: b.lang };
    await saveWaSetting(pool, id, next);
    return { ok: true, phoneNumberId: next.phoneNumberId, hasToken: Boolean(next.token), hasSecret: Boolean(next.appSecret) };
  });

  /** Copia la configurazione WhatsApp (numero, token, chiave, modello) da un altro ambiente: il token resta sul server. */
  app.post('/tenants/:id/whatsapp-copy', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { from } = z.object({ from: z.string().uuid() }).parse(req.body);
    if (from === id) throw new DomainError('same_tenant', "Scegli un ambiente diverso da questo.", 422);
    const src = await getWaSetting(pool, from);
    if (!src.phoneNumberId) throw new DomainError('wa_missing', "L'ambiente scelto non ha un numero WhatsApp configurato.", 422);
    await saveWaSetting(pool, id, { ...src });
    return { ok: true, phoneNumberId: src.phoneNumberId, template: src.template, lang: src.lang, hasToken: Boolean(src.token), hasSecret: Boolean(src.appSecret) };
  });

  /**
   * Attivazione del numero del cliente su Meta, dal pannello:
   * request_code (SMS) → verify_code (codice ricevuto) → register (PIN a 6 cifre scelto da te).
   * Mostra il messaggio di errore esatto di Meta.
   */
  app.post('/tenants/:id/whatsapp-activate', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      step: z.enum(['request_code', 'verify_code', 'register']),
      code: z.string().trim().regex(/^\d{6}$/, 'Il codice ha 6 cifre').optional(),
      pin: z.string().trim().regex(/^\d{6}$/, 'Il PIN ha 6 cifre').optional(),
    }).parse(req.body);
    const cfg = await waConfigFor(id);
    if (!cfg) throw new DomainError('wa_missing', "Prima salva l'ID del numero e un token (qui o nelle variabili di Render).", 422);
    try {
      if (b.step === 'request_code') await wa.numberApi(cfg, 'request_code', { code_method: 'SMS', language: 'it' });
      else if (b.step === 'verify_code') {
        if (!b.code) throw new DomainError('missing_code', 'Scrivi il codice ricevuto via SMS.', 422);
        await wa.numberApi(cfg, 'verify_code', { code: b.code });
      } else {
        if (!b.pin) throw new DomainError('missing_pin', 'Scrivi il PIN a 6 cifre.', 422);
        await wa.numberApi(cfg, 'register', { messaging_product: 'whatsapp', pin: b.pin });
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('wa_failed', `Meta risponde: ${(err as Error).message}`, 422);
    }
    return { ok: true };
  });

  /** Controlla e collega le risposte (webhook) del numero del cliente. */
  app.post('/tenants/:id/whatsapp-link', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cfg = await waConfigFor(id);
    if (!cfg) throw new DomainError('wa_missing', "Prima salva l'ID del numero e un token.", 422);
    const { waba } = z.object({ waba: z.string().trim().regex(/^(\d{6,25})?$/, "L'ID dell'account WhatsApp è fatto solo di cifre").optional().default('') }).parse(req.body ?? {});
    const w = await getWaSetting(pool, id);
    let link;
    try { link = await wa.linkWebhooks(cfg, waba || undefined); }
    catch (err) {
      if ((err as Error).message === 'NEED_WABA') throw new DomainError('need_waba', "Scrivi l'ID dell'account WhatsApp nel campo accanto al tasto: lo trovi in WhatsApp Manager → in alto, sotto il nome dell'account (oppure Impostazioni dell'account WhatsApp → \"ID dell'account WhatsApp Business\"). Non è l'ID del numero.", 422);
      throw new DomainError('wa_failed', `Meta risponde: ${(err as Error).message}`, 422);
    }
    return { ...link, seen: webhookSeen.get(cfg.phoneNumberId) ?? null, hasSecret: Boolean(w.appSecret || config.WHATSAPP_APP_SECRET), base: config.PUBLIC_BASE_URL };
  });

  /** Manda il modello di proposta a un numero di prova con il WhatsApp di questo cliente. */
  app.post('/tenants/:id/whatsapp-test', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { to } = z.object({ to: z.string().trim().min(6) }).parse(req.body);
    const phone = normalizePhone(to);
    if (!phone || phone === 'invalid') throw new DomainError('invalid_phone', 'Numero non valido.', 422);
    const cfg = await waConfigFor(id);
    if (!cfg) throw new DomainError('wa_missing', 'WhatsApp non è configurato: manca l\'ID del numero o il token.', 422);
    const name = (await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [id])).rows[0]?.name ?? 'Prova';
    try {
      await wa.sendProposalTemplate(cfg, phone, ['Mario', name, 'prodotto di prova', 'PROVA-1', 'domani', '08:00 e le 11:00'], 'TEST:0', 'TEST:0');
    } catch (err) {
      throw new DomainError('wa_failed', `Meta ha rifiutato il messaggio: ${(err as Error).message}`, 422);
    }
    return { ok: true, from: cfg.phoneNumberId === config.WHATSAPP_PHONE_NUMBER_ID ? 'generale' : 'cliente' };
  });

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
      features: z.object({ reportAtTime: z.boolean().optional() }).strict().optional(),
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
