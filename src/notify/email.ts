import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
const getTransport = () => (transport ??= nodemailer.createTransport(config.SMTP_URL));

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Testo semplice → HTML: escape e a capo */
export const para = (s: string) => `<p>${esc(s).replace(/\n/g, '<br>')}</p>`;

export async function sendEmail(to: string, subject: string, text: string, html: string): Promise<string> {
  const info = await getTransport().sendMail({ from: config.EMAIL_FROM, to, subject, text, html });
  return info.messageId;
}

export const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:600;${
    primary ? 'background:#0b7a4b;color:#fff' : 'border:1px solid #0b7a4b;color:#0b7a4b'
  }">${esc(label)}</a>`;

export const layout = (inner: string) =>
  `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#18231d;max-width:560px">${inner}</div>`;
