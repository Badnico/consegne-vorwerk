# Mettere online Consegne Vorwerk

Tempo: circa 30 minuti. Non serve il terminale: si fa tutto dal browser.

## 1. Carica il codice su GitHub

1. Vai su **github.com** e crea un account gratuito (o accedi).
2. In alto a destra premi **+**, poi **New repository**.
3. Nome: `consegne-vorwerk`. Scegli **Private**. Premi **Create repository**.
4. Nella pagina che si apre, clicca il link **uploading an existing file**.
5. Estrai lo zip sul computer. Apri la cartella `vorwerk-consegne-backend` e **trascina tutto il suo contenuto** (le cartelle `src`, `public`, `migrations`, `tests` e tutti i file) nella pagina di GitHub.
   - Trascina il contenuto della cartella, non la cartella stessa e non lo zip.
   - Controlla che nell'elenco compaiano `package.json` e `render.yaml`.
6. In fondo premi **Commit changes**.

## 2. Metti online con Render

1. Vai su **render.com** e crea un account. Il modo più semplice è **Sign in with GitHub**.
2. Premi **New +**, poi **Blueprint**.
3. Collega GitHub e scegli il repository `consegne-vorwerk`.
4. Render legge il file `render.yaml` e propone due elementi: il servizio web `consegne-vorwerk` e il database `consegne-db`, entrambi a Francoforte.
5. Ti chiede due valori:
   - **ADMIN_EMAIL**: la tua email, con cui entrerai nel pannello amministratore.
   - **ADMIN_PASSWORD**: una password lunga, almeno 12 caratteri. Conservala.
6. Controlla i piani proposti per il servizio e il database e scegli quelli a pagamento più piccoli: i piani gratuiti si spengono quando non sono usati e il database gratuito scade dopo un periodo limitato.
7. Premi **Apply** (o **Deploy Blueprint**). Il primo avvio richiede qualche minuto.
8. Quando il servizio è **Live**, in alto trovi l'indirizzo, del tipo `https://consegne-vorwerk.onrender.com`. Aprilo: arrivi su `/admin`. Accedi con l'email e la password del punto 5.

## 3. Crea gli ambienti dei clienti

Nel pannello amministratore (`/admin`) premi **Nuovo ambiente** e compila:

- **Nome dell'azienda** e **indirizzo del sito**: il cliente userà `https://consegne-vorwerk.onrender.com/<indirizzo>/`.
- **Utente** e **password** (con **Genera** ne crei una sicura).
- **Email** del referente.
- **Fine abbonamento**: fino a quel giorno compreso il cliente può entrare. Dal giorno dopo l'accesso al suo pannello si blocca da solo; i link già mandati ai suoi destinatari continuano a funzionare.

Alla fine compaiono indirizzo, utente e password da copiare e mandare al cliente. La password non viene più mostrata: se si perde, da **Modifica** ne imposti una nuova.

Da **Modifica** puoi anche rinnovare l'abbonamento (+1 mese, +3, +6, +1 anno), sospendere l'accesso o eliminare l'ambiente.

Se avevi già usato la versione precedente, i dati esistenti si trovano nell'ambiente **vorwerk**: aprilo con **Modifica** e assegnagli utente e password.

## 4. Prima configurazione nell'ambiente di un cliente

Il cliente (o tu, entrando con le sue credenziali) imposta:

1. **Slot e capienza**: controlla fasce, numero di consegne per fascia e giorni attivi.
2. **Area servita**: inserisci i CAP in cui il cliente può scegliere da solo la data.
3. **Messaggi**: rivedi i testi.
4. **Nuova consegna**: crea una consegna di prova con il tuo numero o la tua email.

Finché WhatsApp ed email non sono collegati, i messaggi non partono. Puoi comunque premere **Crea link** nell'anteprima e mandare il link al cliente a mano.

## 5. Collegare WhatsApp ed email (quando sono pronti)

Su Render apri il servizio `consegne-vorwerk`, poi **Environment**, e aggiungi:

| Nome | Dove trovarlo |
| --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers → la tua app → WhatsApp → API Setup |
| `WHATSAPP_ACCESS_TOKEN` | Token di sistema permanente creato in Meta Business |
| `WHATSAPP_APP_SECRET` | Meta for Developers → la tua app → Impostazioni → Base |
| `SMTP_URL` | Dal servizio email scelto, nel formato `smtp://utente:password@server:587` |
| `EMAIL_FROM` | Indirizzo da cui partono le email, es. `Consegne <consegne@tuodominio.it>`. Come nome del mittente il programma mette da solo il nome dell'azienda dell'ambiente |

Poi su Meta registra il webhook `https://<tuo-indirizzo>/webhooks/whatsapp`. Il "verify token" da inserire lo trovi su Render nella variabile `WHATSAPP_VERIFY_TOKEN`.

WhatsApp ed email sono unici per tutto il sistema: i messaggi di tutti gli ambienti partono dallo stesso numero e dallo stesso indirizzo, e ogni messaggio dice per conto di quale azienda arriva. Nelle email il mittente appare con il nome dell'azienda (es. "Rossi Elettrodomestici") e se il destinatario risponde, la risposta va all'email dell'azienda.

### Il modello WhatsApp da far approvare a Meta

Il primo messaggio (quello con i pulsanti Sì e No) deve essere un modello approvato da Meta. Si crea una volta sola e vale per tutte le aziende.

1. Vai su **business.facebook.com**, apri **WhatsApp Manager**, poi **Modelli di messaggio** → **Crea modello**.
2. Categoria: **Utilità** (Utility). Nome: `consegna_proposta`. Lingua: **Italiano**.
3. Corpo del messaggio, copialo esattamente così:

   ```
   Ciao {{1}}, ti scriviamo per conto di {{2}}. Il tuo {{3}} (ordine {{4}}) arriverà {{5}} tra le {{6}}. Sarai a casa?
   ```

4. Meta chiede un esempio per ogni variabile. Scrivi:
   - {{1}} `Mario`
   - {{2}} `Rossi Elettrodomestici`
   - {{3}} `Bimby TM7`
   - {{4}} `A-1024`
   - {{5}} `giovedì 15 ottobre`
   - {{6}} `08:00 e le 11:00`
5. Pulsanti: scegli **Risposta rapida** e aggiungi due pulsanti: `Sì` e `No`.
6. Niente intestazione e niente piè di pagina. Premi **Invia**. L'approvazione di solito arriva in pochi minuti o qualche ora.

Non cambiare l'ordine delle variabili: il programma le riempie in quest'ordine. Il nome dell'azienda è quello scritto in **Nome dell'azienda** quando crei l'ambiente.

## Aggiornare il programma

Quando ricevi una versione nuova, caricala di nuovo su GitHub nello stesso modo, sostituendo i file. Render la mette online da solo in pochi minuti. I dati nel database restano.
