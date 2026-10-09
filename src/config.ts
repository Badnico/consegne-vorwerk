import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  // Su Render l'indirizzo pubblico arriva da RENDER_EXTERNAL_URL
  PUBLIC_BASE_URL: z.string().url().default(process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'),
  TIMEZONE: z.string().default('Europe/Rome'),
  DATABASE_URL: z.string().default('postgres://consegne:consegne@localhost:5432/consegne'),
  ADMIN_API_KEY: z.string().min(16).default('dev-admin-key-change-me'),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),

  BOOKING_HORIZON_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BOOKING_LEAD_DAYS: z.coerce.number().int().min(0).max(14).default(1),
  REMINDER_AFTER_HOURS: z.coerce.number().positive().default(24),
  NO_RESPONSE_AFTER_HOURS: z.coerce.number().positive().default(48),
  TOKEN_MAX_DAYS: z.coerce.number().int().positive().default(21),

  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_TEMPLATE_PROPOSAL: z.string().default('consegna_proposta'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('it'),

  SMTP_URL: z.string().default(''),
  EMAIL_FROM: z.string().default('Consegne <consegne@example.it>'),
});

export const config = schema.parse(process.env);
export type Config = typeof config;

export const whatsappEnabled = () => Boolean(config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN);
export const emailEnabled = () => Boolean(config.SMTP_URL);
