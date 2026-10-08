import type { ServerResponse } from 'node:http';
import { pool } from './db.js';
import { SLOT_CHANNEL } from '../domain/slots.js';

/**
 * Disponibilità in tempo reale: una connessione LISTEN su Postgres per processo,
 * inoltrata a tutte le pagine cliente aperte via Server-Sent Events.
 * Con più istanze dell'app funziona lo stesso: ogni istanza ascolta lo stesso canale.
 */
const clients = new Set<ServerResponse>();

export async function startLive() {
  const conn = await pool.connect();
  await conn.query(`LISTEN ${SLOT_CHANNEL}`);
  conn.on('notification', (msg) => {
    const data = `event: slots\ndata: ${msg.payload ?? '"all"'}\n\n`;
    for (const res of clients) res.write(data);
  });
  // Tiene vive le connessioni dietro proxy che chiudono i flussi inattivi
  const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  return () => {
    clearInterval(ping);
    conn.release();
  };
}

export function subscribe(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}
