# Consegne Vorwerk

**Per metterlo online senza terminale: leggi `GUIDA-ONLINE.md`.**

Sistema per proporre data e fascia di consegna, raccogliere Sì/No via WhatsApp o email e far scegliere al cliente uno slot libero da un link personale. Node.js 20+, TypeScript, Fastify, PostgreSQL. La coda dei lavori (pg-boss) usa lo stesso Postgres.

## Avvio in locale

```bash
cp .env.example .env          # compila le chiavi quando le hai
docker compose up -d          # Postgres 16 su localhost:5432
npm install
npm run seed                  # schema + fasce di esempio lun–sab, 4 fasce al giorno
npm run dev                   # pannello su http://localhost:3000 (in locale: admin@example.it / consegne-locale)
npm run demo                  # in un secondo terminale: crea una consegna di prova e stampa il link cliente
```

Per un link cliente di una consegna esistente: `POST /api/deliveries/:id/link`.

Senza chiavi WhatsApp e SMTP il sistema funziona, ma i job di invio falliscono e vengono ritentati: utile per provare i flussi dalle API.

## Test

```bash
createdb consegne_test
DATABASE_URL=postgres://consegne:consegne@localhost:5432/consegne_test npm test
```

I test verificano la parte critica: 10 proposte in parallelo su 3 posti, due clienti sull'ultimo posto, rilascio del posto al No, scadenza dei link.

## Struttura

```
migrations/001_init.sql     schema: fasce, eccezioni, slot, consegne, token, messaggi, storico
src/server.ts               avvio: migrazioni, generazione slot, coda, stream, HTTP
src/app.ts                  Fastify, gestione errori, registrazione delle rotte
src/domain/slots.ts         capienza: reserve/release atomici, generazione slot, disponibilità
src/domain/deliveries.ts    stati della consegna e transizioni (Sì, No, nuova scelta, scadenza)
src/domain/tokens.ts        link personali: token casuale, solo hash nel DB, scadenza
src/notify/                 WhatsApp Cloud API, email SMTP, Notifier con ripiego su email
src/jobs/queue.ts           invio proposta, sollecito, link dopo il No, conferma, scadenza, slot notturni
src/lib/live.ts             LISTEN/NOTIFY di Postgres → Server-Sent Events per le pagine cliente
src/routes/admin.ts         API operatori (/api/...)
src/routes/customer.ts      link cliente (/r/:token/...)
src/routes/customer-page.ts pagina cliente senza dipendenze
src/routes/webhooks.ts      webhook WhatsApp (firma HMAC, deduplica) ed email
tests/booking.test.ts       test di concorrenza e dei flussi
```

## Come funziona la capienza

Ogni slot ha `capacity` e `booked`. Un posto si occupa solo con:

```sql
UPDATE slots SET booked = booked + 1 WHERE id = $1 AND booked < capacity RETURNING id;
```

Se due richieste arrivano insieme sull'ultimo posto, Postgres le serializza sulla stessa riga e solo una trova posto. La disponibilità mostrata al cliente è solo informativa: la verifica vera avviene in `book`.

Una proposta in attesa occupa già il posto. Il No lo libera subito. Una nuova scelta occupa il nuovo posto prima di liberare il vecchio, quindi se il nuovo è pieno non cambia nulla.

## Pannello operatori

`/` dopo il login (`/login`): calendario, consegne con filtri ed esito (consegnata, non consegnata, elimina), nuova consegna, slot e capienza, area servita per CAP, testi dei messaggi, anteprima di ciò che vede il cliente e link personale con QR. Usa le API sotto `/api/panel`.

Il primo amministratore nasce da `ADMIN_EMAIL` e `ADMIN_PASSWORD` al primo avvio.

## Area servita

Se il cliente risponde No e il suo CAP è nell'area (CAP singoli, intervalli `20121-20162` o prefissi `201*`), riceve il link per scegliere la data. Fuori area la consegna diventa `out_of_area`, il cliente riceve un messaggio dedicato e l'operatore assegna la data dal pannello.

## API per integrazioni

Autenticazione: sessione del pannello oppure `Authorization: Bearer $ADMIN_API_KEY` (per un import automatico da Vorwerk).

| Metodo | Percorso | Cosa fa |
| --- | --- | --- |
| POST | `/api/deliveries` | Crea una consegna (con `slot_id` oppure `date` + `start_time`) e accoda il messaggio |
| POST | `/api/deliveries/import` | CSV (`text/csv`): `order_ref,name,phone_e164,email,consent_whatsapp,address,product,date,start_time` |
| GET | `/api/deliveries?from=&to=&status=` | Lista |
| GET | `/api/deliveries/:id` | Dettaglio con storico e messaggi |
| POST | `/api/deliveries/:id/resend` | Reinvia proposta o link |
| POST | `/api/deliveries/:id/confirm` · `/decline` · `/book` | Azioni per conto del cliente |
| GET | `/api/calendar?from=&to=` | Slot con capienza, occupati e consegne |
| GET · PUT | `/api/slot-templates` | Fasce ricorrenti; il PUT rigenera gli slot e segnala quelli oltre capienza |
| PUT | `/api/slot-overrides/:date` | Eccezioni per una data (`capacity: 0` chiude la fascia) |

Esempio:

```bash
curl -X POST localhost:3000/api/deliveries \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"order_ref":"VK-24817","customer":{"name":"Marco Bellini","phone_e164":"+393470000002","consent_whatsapp":true},
       "address":"Corso Lodi 45, Milano","product":"Thermomix TM7","date":"2026-10-12","start_time":"08:00"}'
```

## Configurare WhatsApp

1. Crea un'app su Meta for Developers con il prodotto WhatsApp e collega un numero dedicato.
2. Crea il template `consegna_proposta`, categoria Utility, lingua italiano, con cinque variabili nel corpo e due pulsanti di risposta rapida "Sì" e "No". Testo suggerito in `src/notify/whatsapp.ts`.
3. Registra il webhook `https://<dominio>/webhooks/whatsapp` con `WHATSAPP_VERIFY_TOKEN` e iscriviti al campo `messages`.
4. Compila `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (token di sistema permanente) e `WHATSAPP_APP_SECRET`.

## Prima della produzione

- 2FA o SSO per gli operatori e gestione di più utenti dal pannello.
- Limite di richieste su `/r/:token` (per token e per IP).
- Ripiego su email quando Meta segnala `failed` nello stato del messaggio (punto segnato in `webhooks.ts`).
- Deduplica dei clienti per telefono o email e gestione dei rimbalzi email.
- Monitoraggio errori, backup del database, conservazione e cancellazione dei dati come da accordo con Vorwerk.
