import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Client minimo per WhatsApp Cloud API (Meta).
 * Il template "consegna_proposta" va creato e approvato in WhatsApp Manager, categoria Utility, lingua it:
 *   Corpo:  "Ciao {{1}}, ti scriviamo per conto di {{2}}. Il tuo {{3}} (ordine {{4}}) arriverà {{5}} tra le {{6}}. Sarai a casa?"
 *   {{1}} nome, {{2}} azienda (nome dell'ambiente), {{3}} prodotto, {{4}} ordine, {{5}} data, {{6}} "08:00 e le 11:00".
 *   Pulsanti: due risposte rapide, "Sì" e "No". Il payload di ciascun pulsante lo impostiamo all'invio.
 */
const endpoint = () => `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

export class WhatsAppError extends Error {
  constructor(message: string, public retryable: boolean, public detail?: unknown) {
    super(message);
  }
}

async function post(body: unknown): Promise<string> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...(body as object) }),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok) throw new WhatsAppError(json.error?.message ?? `HTTP ${res.status}`, res.status >= 500 || res.status === 429, json);
  const id = json.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('Risposta senza id messaggio', false, json);
  return id;
}

export const toWaNumber = (e164: string) => e164.replace(/[^\d]/g, '');

export function sendProposalTemplate(to: string, params: string[], yesPayload: string, noPayload: string) {
  return post({
    to: toWaNumber(to),
    type: 'template',
    template: {
      name: config.WHATSAPP_TEMPLATE_PROPOSAL,
      language: { code: config.WHATSAPP_TEMPLATE_LANG },
      components: [
        { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: yesPayload }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: noPayload }] },
      ],
    },
  });
}

/** Testo libero: ammesso solo entro 24 ore dall'ultimo messaggio del cliente. */
export function sendText(to: string, body: string) {
  return post({ to: toWaNumber(to), type: 'text', text: { body, preview_url: true } });
}

/** Verifica X-Hub-Signature-256 sul corpo grezzo della richiesta. */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.WHATSAPP_APP_SECRET || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* Struttura (ridotta) del webhook Meta */
export interface WaWebhook {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          id: string;
          from: string;
          type: string;
          button?: { payload?: string; text?: string };
          interactive?: { button_reply?: { id: string; title: string } };
          text?: { body: string };
        }[];
        statuses?: { id: string; status: string; errors?: unknown[] }[];
      };
    }[];
  }[];
}
