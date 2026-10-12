import { pool } from '../lib/db.js';
import { emailEnabled } from '../config.js';
import { formatDateIt, hhmm, todayLocal } from '../lib/dates.js';
import { getDelivery, type DeliveryView } from '../domain/deliveries.js';
import { createToken, customerUrl } from '../domain/tokens.js';
import { fillText, getMessages, getWaSetting, type Messages } from '../domain/settings.js';
import * as wa from './whatsapp.js';
import { button, layout, para, sendEmail } from './email.js';

type Kind = 'proposal' | 'reminder' | 'reschedule_link' | 'confirmation' | 'out_of_area' | 'pin_question';

export const formatEuro = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

/**
 * Testo di conferma completo: il testo della scheda Messaggi + indirizzo di consegna (se il testo non lo contiene già)
 * + contrassegno da pagare (se > 0) + ritiro del vecchio prodotto (se previsto).
 */
export function confirmationText(m: Messages, d: DeliveryView, base: keyof Messages, v: Record<string, string>) {
  const parts = [fillText(m[base], v)];
  if (!m[base].includes('{indirizzo}')) parts.push(fillText(m.extra_address, v));
  if ((Number(d.cod_amount) || 0) > 0) parts.push(fillText(m.extra_cod, v));
  if (d.pickup) parts.push(fillText(m.extra_pickup, v));
  return parts.filter((p) => p.trim()).join('\n');
}

/** Valori dei campi {nome}, {data}, ... per una consegna. "proposed" usa lo slot proposto all'inizio. */
export function messageVars(d: DeliveryView, which: 'proposed' | 'current', link = '') {
  const date = which === 'proposed' ? d.proposed_date : d.date;
  const start = which === 'proposed' ? d.proposed_start : d.start_time;
  const end = which === 'proposed' ? d.proposed_end : d.end_time;
  return {
    azienda: d.tenant_name,
    contrassegno: formatEuro(Number(d.cod_amount) || 0),
    nome: d.customer_name.split(' ')[0] ?? d.customer_name,
    prodotto: d.product ?? 'ordine',
    ordine: d.order_ref,
    data: date ? formatDateIt(date) : '',
    inizio: start ? hhmm(start) : '',
    fine: end ? hhmm(end) : '',
    fascia: start && end ? `${hhmm(start)}–${hhmm(end)}` : '',
    indirizzo: d.address,
    link,
  };
}

async function record(deliveryId: string, channel: 'whatsapp' | 'email', kind: Kind, providerId: string | null, status: string, payload?: unknown) {
  await pool.query(
    'INSERT INTO messages (delivery_id, channel, direction, kind, provider_id, status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [deliveryId, channel, 'out', kind, providerId, status, payload ? JSON.stringify(payload) : null],
  );
}

/** Numero WhatsApp da usare per un ambiente: il suo se impostato, altrimenti quello generale. */
export async function waConfigFor(tenantId: string): Promise<wa.WaConfig | null> {
  const g = wa.globalWaConfig();
  const t = await getWaSetting(pool, tenantId);
  if (t.phoneNumberId) {
    const token = t.token || g?.token;
    if (!token) return null;
    return { phoneNumberId: t.phoneNumberId, token, template: t.template || g?.template || 'consegna_proposta', lang: t.lang || g?.lang || 'it' };
  }
  return g;
}

const canEmail = (d: DeliveryView) => emailEnabled() && Boolean(d.email);

/** Prova WhatsApp, poi email. Lancia se nessun canale riesce, così la coda ritenta. */
async function deliver(d: DeliveryView, kind: Kind, viaWa: ((c: wa.WaConfig) => Promise<string>) | null, viaMail: () => Promise<string>) {
  const cfg = viaWa && d.phone_e164 && d.consent_whatsapp ? await waConfigFor(d.tenant_id) : null;
  if (viaWa && cfg) {
    try {
      await record(d.id, 'whatsapp', kind, await viaWa(cfg), 'sent');
      return 'whatsapp' as const;
    } catch (err) {
      await record(d.id, 'whatsapp', kind, null, 'failed', { error: String(err) });
      if (!canEmail(d)) throw err;
    }
  }
  if (canEmail(d)) {
    await record(d.id, 'email', kind, await viaMail(), 'sent');
    return 'email' as const;
  }
  throw new Error(`Nessun canale disponibile per la consegna ${d.order_ref}`);
}

const linkFor = async (d: DeliveryView) => customerUrl(await createToken(pool, d.id, d.date ?? d.proposed_date ?? todayLocal()));
/** Mittente: nome dell'azienda cliente, indirizzo unico del sistema; le risposte vanno all'email dell'azienda. */
const sender = (d: DeliveryView) => ({ name: d.tenant_name, replyTo: d.tenant_email });
const t = (m: Messages, k: keyof Messages, v: Record<string, string>) => fillText(m[k], v);

/** Proposta iniziale (e sollecito). Su WhatsApp usa il modello approvato da Meta con i pulsanti Sì/No. */
export async function sendProposal(deliveryId: string, kind: 'proposal' | 'reminder' = 'proposal') {
  const d = await getDelivery(pool, deliveryId);
  if (d.status !== 'proposed') return null; // già risposto: niente invio
  const m = await getMessages(pool, d.tenant_id);
  const url = await linkFor(d);
  const v = messageVars(d, 'proposed', url);
  return deliver(
    d,
    kind,
    (c) => wa.sendProposalTemplate(c, d.phone_e164!, [v.nome, v.azienda, v.prodotto, v.ordine, v.data, `${v.inizio} e le ${v.fine}`], `YES:${d.id}`, `NO:${d.id}`),
    () => {
      const subject = t(m, 'mail_subject', v);
      const text = `${t(m, 'mail_body', v)}\n\nConsegna proposta: ${v.data}, ${v.fascia}\n\n${t(m, 'mail_question', v)}\n${url}\n`;
      const html = layout(
        para(t(m, 'mail_body', v)) +
        `<p><strong>${v.data}, ${v.fascia}</strong></p>` +
        para(t(m, 'mail_question', v)) +
        `<p>${button(`${url}?scelta=si`, t(m, 'mail_yes', v))} &nbsp; ${button(`${url}?scelta=no`, t(m, 'mail_no', v), false)}</p>`,
      );
      return sendEmail(sender(d), d.email!, subject, text, html);
    },
  );
}

/** Dopo un "No" dentro l'area. Su WhatsApp il cliente ha appena scritto: la finestra di 24 ore è aperta. */
export async function sendRescheduleLink(deliveryId: string) {
  const d = await getDelivery(pool, deliveryId);
  const m = await getMessages(pool, d.tenant_id);
  const url = await linkFor(d);
  const v = messageVars(d, 'current', url);
  return deliver(
    d,
    'reschedule_link',
    (c) => wa.sendText(c, d.phone_e164!, t(m, 'wa_declined', v)),
    () => sendEmail(sender(d), d.email!, t(m, 'mail_subject', v), `${t(m, 'mail_reschedule', v)}\n${url}\n`,
      layout(`<p><strong>${t(m, 'mail_reschedule', v)}</strong></p><p>${button(url, t(m, 'mail_reschedule', v))}</p>`)),
  );
}

/** Dopo un "No" fuori dall'area servita: niente link, lo contatterà un operatore. */
export async function sendOutOfArea(deliveryId: string) {
  const d = await getDelivery(pool, deliveryId);
  const m = await getMessages(pool, d.tenant_id);
  const v = messageVars(d, 'current');
  return deliver(
    d,
    'out_of_area',
    (c) => wa.sendText(c, d.phone_e164!, t(m, 'wa_out_area', v)),
    () => sendEmail(sender(d), d.email!, t(m, 'mail_subject', v), t(m, 'mail_out_area', v), layout(para(t(m, 'mail_out_area', v)))),
  );
}

export async function sendConfirmation(deliveryId: string) {
  const d = await getDelivery(pool, deliveryId);
  if (d.status !== 'confirmed' && d.status !== 'rescheduled') return null; // es. in attesa della risposta sul PIN
  const m = await getMessages(pool, d.tenant_id);
  const url = await linkFor(d);
  const v = messageVars(d, 'current', url);
  const rescheduled = d.status === 'rescheduled';
  return deliver(
    d,
    'confirmation',
    (c) => wa.sendText(c, d.phone_e164!, confirmationText(m, d, rescheduled ? 'wa_rescheduled' : 'wa_confirmed', v)),
    () => {
      const body = confirmationText(m, d, rescheduled ? 'mail_rescheduled' : 'mail_confirmed', v);
      return sendEmail(sender(d), d.email!, t(m, 'mail_subject', v), `${body}\n\n${url}\n`, layout(para(body) + `<p><a href="${url}">Devi cambiarla?</a></p>`));
    },
  );
}

/** Dopo il Sì: "Hai ricevuto il PIN?" con i pulsanti Sì/No. Su WhatsApp il cliente ha appena scritto: la finestra di 24 ore è aperta. */
export async function sendPinQuestion(deliveryId: string) {
  const d = await getDelivery(pool, deliveryId);
  if (d.status !== 'pin_check') return null;
  const m = await getMessages(pool, d.tenant_id);
  const url = await linkFor(d);
  const v = messageVars(d, 'current', url);
  return deliver(
    d,
    'pin_question',
    (c) => wa.sendButtons(c, d.phone_e164!, t(m, 'wa_pin_question', v), [
      { id: `PINYES:${d.id}`, title: t(m, 'wa_pin_yes', v) },
      { id: `PINNO:${d.id}`, title: t(m, 'wa_pin_no', v) },
    ]),
    () => sendEmail(sender(d), d.email!, t(m, 'mail_subject', v), `${t(m, 'wa_pin_question', v)}\n${url}\n`,
      layout(`<p><strong>${t(m, 'wa_pin_question', v)}</strong></p><p>${button(url, 'Rispondi')}</p>`)),
  );
}
