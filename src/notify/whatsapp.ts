import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Client minimo per WhatsApp Cloud API (Meta).
 * Il template "consegna_proposta" va creato e approvato in WhatsApp Manager, categoria Utility, lingua it:
 *   Corpo:  "Ciao {{1}}, ti scriviamo per conto di {{2}}. Il tuo {{3}} (ordine {{4}}) arriverà {{5}} tra le {{6}}. Sarai a casa?"
 *   {{1}} nome, {{2}} azienda (nome dell'ambiente), {{3}} prodotto, {{4}} ordine, {{5}} data, {{6}} "08:00 e le 11:00".
 *   Pulsanti: due risposte rapide, "Sì" e "No". Il payload di ciascun pulsante lo impostiamo all'invio.
 */
/** Numero da cui partono i messaggi: quello generale (variabili su Render) o quello del cliente (pannello amministratore). */
export interface WaConfig { phoneNumberId: string; token: string; template: string; lang: string }

export const globalWaConfig = (): WaConfig | null =>
  config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN
    ? { phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID, token: config.WHATSAPP_ACCESS_TOKEN, template: config.WHATSAPP_TEMPLATE_PROPOSAL, lang: config.WHATSAPP_TEMPLATE_LANG }
    : null;

const endpoint = (c: WaConfig) => `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${c.phoneNumberId}/messages`;

export class WhatsAppError extends Error {
  constructor(message: string, public retryable: boolean, public detail?: unknown) {
    super(message);
  }
}

async function post(c: WaConfig, body: unknown): Promise<string> {
  const res = await fetch(endpoint(c), {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...(body as object) }),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok) throw new WhatsAppError(json.error?.message ?? `HTTP ${res.status}`, res.status >= 500 || res.status === 429, json);
  const id = json.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('Risposta senza id messaggio', false, json);
  return id;
}

export const toWaNumber = (e164: string) => e164.replace(/[^\d]/g, '');

export function sendProposalTemplate(c: WaConfig, to: string, params: string[], yesPayload: string, noPayload: string) {
  return post(c, {
    to: toWaNumber(to),
    type: 'template',
    template: {
      name: c.template,
      language: { code: c.lang },
      components: [
        { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: yesPayload }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: noPayload }] },
      ],
    },
  });
}

/** Messaggio con pulsanti di risposta rapida (max 3, titolo max 20 caratteri): ammesso entro 24 ore dall'ultimo messaggio del cliente. */
export function sendButtons(c: WaConfig, to: string, body: string, buttons: { id: string; title: string }[]) {
  return post(c, {
    to: toWaNumber(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

/** Testo libero: ammesso solo entro 24 ore dall'ultimo messaggio del cliente. */
export function sendText(c: WaConfig, to: string, body: string) {
  return post(c, { to: toWaNumber(to), type: 'text', text: { body, preview_url: true } });
}

/** Verifica X-Hub-Signature-256 sul corpo grezzo della richiesta. */
export function verifySignature(rawBody: Buffer, header: string | undefined, secrets: string[] = [config.WHATSAPP_APP_SECRET]): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  return secrets.filter(Boolean).some((secret) => {
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/* Struttura (ridotta) del webhook Meta */
export interface WaWebhook {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: {
          id: string;
          from: string;
          type: string;
          button?: { payload?: string; text?: string };
          interactive?: { button_reply?: { id: string; title: string } };
          text?: { body: string };
          image?: { caption?: string };
          document?: { filename?: string };
        }[];
        statuses?: { id: string; status: string; errors?: unknown[] }[];
      };
    }[];
  }[];
}
