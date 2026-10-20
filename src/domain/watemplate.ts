import { pool } from '../lib/db.js';
import { DomainError } from '../lib/errors.js';
import { config } from '../config.js';
import * as wa from '../notify/whatsapp.js';
import { waConfigFor } from '../notify/notifier.js';
import { getMessages, getWaSetting, getWaTemplate, saveWaSetting, saveWaTemplate, type WaTemplateSetting } from './settings.js';

/**
 * Modello WhatsApp personalizzato per la proposta di consegna.
 * Il primo messaggio a un cliente deve essere un modello approvato da Meta: il testo scritto nella scheda
 * Messaggi viene trasformato ({nome} → {{1}} ...) e mandato a Meta. Quando Meta lo approva, le nuove
 * proposte partono con quel testo; nel frattempo, o se viene rifiutato, si usa il modello standard.
 */

const EXAMPLE: Record<string, string> = {
  nome: 'Giulia', prodotto: 'Thermomix TM7', ordine: 'ORD-12345', data: 'mercoledì 28 ottobre',
  inizio: '08:00', fine: '13:00', fascia: '08:00–13:00', indirizzo: 'Via Roma 1, Milano',
  link: 'https://www.smartconsegne.com/c/esempio', contrassegno: '120,00 €',
};

/** {nome} → {{1}}, nell'ordine in cui compaiono; restituisce anche l'elenco delle variabili. */
export function toMetaBody(text: string) {
  const vars: string[] = [];
  const body = text.trim().replace(/\{(\w+)\}/g, (_m, k: string) => { vars.push(k); return `{{${vars.length}}}`; });
  return { body, vars };
}

/** Controlli che Meta fa di sicuro: meglio dirlo subito che aspettare un rifiuto. */
export function checkForMeta(text: string) {
  const t = text.trim();
  if (!t) return 'Il testo è vuoto.';
  if (t.length > 1024) return 'Il testo supera i 1024 caratteri ammessi da WhatsApp.';
  if (/^\{\w+\}/.test(t)) return 'Meta non accetta un testo che comincia con un campo tra graffe: metti almeno una parola prima (es. "Ciao {nome}").';
  if (/\{\w+\}[\s.!?]*$/.test(t)) return 'Meta non accetta un testo che finisce con un campo tra graffe: aggiungi una frase dopo (es. "Sarai a casa?").';
  if (/\{\w+\}\s*\{\w+\}/.test(t)) return 'Due campi tra graffe non possono stare attaccati: metti almeno una parola in mezzo.';
  if (/\n{3,}/.test(t)) return 'Troppe righe vuote di seguito: al massimo una riga vuota.';
  return null;
}

async function wabaFor(tenantId: string, c: wa.WaConfig) {
  const w = await getWaSetting(pool, tenantId);
  if (w.phoneNumberId && w.waba) return w.waba;
  // stesso numero del generale, o di un'altra azienda che conosce già il suo account WhatsApp
  if ((!w.phoneNumberId || w.phoneNumberId === config.WHATSAPP_PHONE_NUMBER_ID) && config.WHATSAPP_WABA_ID) return config.WHATSAPP_WABA_ID;
  const other = await pool.query<{ waba: string }>(
    "SELECT value->>'waba' AS waba FROM settings WHERE key = 'whatsapp' AND value->>'phoneNumberId' = $1 AND coalesce(value->>'waba', '') <> '' LIMIT 1", [c.phoneNumberId]);
  if (other.rows[0]) { if (w.phoneNumberId) await saveWaSetting(pool, tenantId, { ...w, waba: other.rows[0].waba }); return other.rows[0].waba; }
  const found = await wa.findWaba(c);
  if (found && w.phoneNumberId) await saveWaSetting(pool, tenantId, { ...w, waba: found });
  if (found) return found;
  throw new DomainError('need_waba', "Manca l'ID dell'account WhatsApp di questo numero: contatta l'assistenza SmartConsegne per completare la configurazione.", 422);
}

/** Manda a Meta il testo attuale della proposta WhatsApp. */
export async function submitTemplate(tenantId: string) {
  const c = await waConfigFor(tenantId);
  if (!c) throw new DomainError('wa_missing', 'WhatsApp non è configurato per questa azienda.', 422);
  const m = await getMessages(pool, tenantId);
  const problem = checkForMeta(m.wa_proposal);
  if (problem) throw new DomainError('wa_text', problem, 422);
  const tenant = (await pool.query<{ slug: string; name: string }>('SELECT slug, name FROM tenants WHERE id = $1', [tenantId])).rows[0]!;
  const { body, vars } = toMetaBody(m.wa_proposal);
  const waba = await wabaFor(tenantId, c);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const name = `proposta_${tenant.slug.replace(/[^a-z0-9]/g, '_')}_${stamp}`.slice(0, 100);
  const examples = vars.map((k) => (k === 'azienda' ? tenant.name : EXAMPLE[k] ?? 'esempio'));
  let r;
  try { r = await wa.createProposalTemplate(c.token, waba, name, 'it', body, examples); }
  catch (err) { throw new DomainError('wa_failed', `Meta non ha accettato il testo: ${(err as Error).message}`, 422); }
  const now = new Date().toISOString();
  const v: WaTemplateSetting = {
    name, id: String(r.id ?? ''), text: m.wa_proposal.trim(), vars, waba,
    status: String(r.status ?? 'PENDING'), reason: '', category: String(r.category ?? 'UTILITY'), submittedAt: now, checkedAt: now,
  };
  await saveWaTemplate(pool, tenantId, v);
  return v;
}

/** Aggiorna lo stato da Meta se è in attesa (al massimo ogni `minSeconds`). */
export async function refreshTemplate(tenantId: string, minSeconds = 30) {
  const v = await getWaTemplate(pool, tenantId);
  if (!v || ['APPROVED', 'REJECTED', 'DISABLED'].includes(v.status)) return v;
  if (Date.now() - Date.parse(v.checkedAt) < minSeconds * 1000) return v;
  const c = await waConfigFor(tenantId);
  if (!c) return v;
  try {
    const s = await wa.templateStatus(c.token, v.waba, v.name);
    const next = { ...v, checkedAt: new Date().toISOString(), ...(s ? { status: s.status, reason: s.reason, category: s.category || v.category } : {}) };
    await saveWaTemplate(pool, tenantId, next);
    return next;
  } catch (err) {
    console.warn('[modello WhatsApp] stato non letto:', (err as Error).message);
    return v;
  }
}

/** Modello personalizzato da usare per l'invio, se approvato da Meta. */
export async function approvedTemplate(tenantId: string) {
  const v = await getWaTemplate(pool, tenantId);
  return v && v.status === 'APPROVED' ? v : null;
}

/** Aziende con un modello in attesa: lo stato si controlla anche senza aprire il portale. */
export async function refreshPendingTemplates() {
  const r = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM settings WHERE key = 'wa_template' AND value->>'status' NOT IN ('APPROVED', 'REJECTED', 'DISABLED')");
  for (const { tenant_id } of r.rows) await refreshTemplate(tenant_id, 600);
}
