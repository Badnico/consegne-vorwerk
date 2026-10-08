# Consegne Vorwerk

**Per metterlo online senza terminale: leggi `GUIDA-ONLINE.md`.**

Sistema per proporre data e fascia di consegna, raccogliere Sì/No via WhatsApp o email e far scegliere al cliente uno slot libero da un link personale. Node.js 20+, TypeScript, Fastify, PostgreSQL. La coda dei lavori (pg-boss) usa lo stesso Postgres.

## Avvio in locale

```bash
cp .env.example .env          # compila le chiavi quando le hai
docker compose up -d          # Postgres 16 su localhost:5432
npm install
npm run seed                  # superamministratore + ambiente di prova "demo"
npm run dev                   # http://localhost:3000/admin (admin@example.it / consegne-locale)
                              # http://localhost:3000/demo/  (demo / consegne-locale)
npm run demo                  # in un secondo terminale: crea una consegna di prova in "demo" e stampa il link cliente
```

Per un link cliente di una consegna esistente: pulsante **Crea link** nel pannello.

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
src/routes/session.ts       accessi e pagine: /admin, /<ambiente>/, login
src/routes/superadmin.ts    API del pannello amministratore (/api/admin/...)
src/routes/panel.ts         API del pannello di un ambiente (/api/panel/...)
src/domain/tenants.ts       ambienti: creazione, rinnovo, sospensione, eliminazione
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

## Ambienti (più clienti)

Ogni azienda cliente ha un ambiente separato con indirizzo `/<ambiente>/`, utente e password, dati, fasce, area e testi propri, e una data di fine abbonamento. Il superamministratore li gestisce da `/admin` (crea, rinnova, sospendi, cambia password, elimina). Con abbonamento scaduto o sospeso il pannello del cliente si chiude subito, anche per chi è già dentro; i link dei destinatari restano attivi. Tutte le query sono filtrate per `tenant_id`; i test verificano che un ambiente non veda né modifichi i dati di un altro.

## Pannello operatori

`/<ambiente>/` dopo il login (`/<ambiente>/login`): calendario, consegne con filtri ed esito (consegnata, non consegnata, elimina), nuova consegna, slot e capienza, area servita per CAP, testi dei messaggi, anteprima di ciò che vede il cliente e link personale con QR. Usa le API sotto `/api/panel`.

Il superamministratore (`/admin`) nasce da `ADMIN_EMAIL` e `ADMIN_PASSWORD` al primo avvio.

## Area servita

Se il cliente risponde No e il suo CAP è nell'area (CAP singoli, intervalli `20121-20162` o prefissi `201*`), riceve il link per scegliere la data. Fuori area la consegna diventa `out_of_area`, il cliente riceve un messaggio dedicato e l'operatore assegna la data dal pannello.

## API per integrazioni

Le API dell'ambiente (`/api/panel/...`) usano la sessione del pannello. Un'API con chiave per ambiente, per importare gli ordini in automatico, è da aggiungere quando servirà.

## Configurare WhatsApp

1. Crea un'app su Meta for Developers con il prodotto WhatsApp e collega un numero dedicato.
2. Crea il template `consegna_proposta`, categoria Utility, lingua italiano, con sei variabili nel corpo (la seconda è il nome dell'azienda dell'ambiente) e due pulsanti di risposta rapida "Sì" e "No". Testo esatto in `src/notify/whatsapp.ts` e in `GUIDA-ONLINE.md`.
3. Registra il webhook `https://<dominio>/webhooks/whatsapp` con `WHATSAPP_VERIFY_TOKEN` e iscriviti al campo `messages`.
4. Compila `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (token di sistema permanente) e `WHATSAPP_APP_SECRET`.

## Un solo numero e un solo mittente per tutti gli ambienti

WhatsApp ed email sono configurati una volta per tutto il sistema. Ogni messaggio dice per conto di quale azienda arriva: il modello WhatsApp riceve il nome dell'ambiente come variabile `{{2}}`, le email partono dall'indirizzo di `EMAIL_FROM` con il nome dell'azienda come mittente e "Rispondi a" verso l'email dell'ambiente. Nei testi è disponibile il campo `{azienda}`.

## Prima della produzione

- 2FA o SSO per gli operatori e gestione di più utenti dal pannello.
- Limite di richieste su `/r/:token` (per token e per IP).
- Ripiego su email quando Meta segnala `failed` nello stato del messaggio (punto segnato in `webhooks.ts`).
- Deduplica dei clienti per telefono o email e gestione dei rimbalzi email.
- Monitoraggio errori, backup del database, conservazione e cancellazione dei dati come da accordo con Vorwerk.
