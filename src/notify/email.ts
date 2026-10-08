import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
const getTransport = () => (transport ??= nodemailer.createTransport(config.SMTP_URL));

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Testo semplice → HTML: escape e a capo */
export const para = (s: string) => `<p>${esc(s).replace(/\n/g, '<br>')}</p>`;

/** Indirizzo di EMAIL_FROM senza il nome: "Vorwerk Consegne <a@b.it>" → "a@b.it" */
export const fromAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim();

/**
 * Tutte le email partono dallo stesso indirizzo (EMAIL_FROM), ma con il nome dell'azienda come mittente
 * ("Rossi Elettrodomestici <consegne@...>") e con "Rispondi a" verso l'email dell'azienda.
 */
export async function sendEmail(sender: { name: string; replyTo?: string }, to: string, subject: string, text: string, html: string): Promise<string> {
  const from = { name: sender.name.replace(/[\r\n"<>]/g, ' ').trim() || 'Consegne', address: fromAddress(config.EMAIL_FROM) };
  const info = await getTransport().sendMail({ from, replyTo: sender.replyTo || undefined, to, subject, text, html });
  return info.messageId;
}

export const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:600;${
    primary ? 'background:#0b7a4b;color:#fff' : 'border:1px solid #0b7a4b;color:#0b7a4b'
  }">${esc(label)}</a>`;

export const layout = (inner: string) =>
  `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#18231d;max-width:560px">${inner}</div>`;
