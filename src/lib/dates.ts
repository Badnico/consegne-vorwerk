import { config } from '../config.js';

/** Data di oggi (YYYY-MM-DD) nel fuso del servizio, non in quello del server. */
export function todayLocal(tz = config.TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = domenica ... 6 = sabato */
export function weekday(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export function formatDateIt(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export const hhmm = (t: string) => t.slice(0, 5);
