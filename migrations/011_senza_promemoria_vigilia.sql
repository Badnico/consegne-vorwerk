-- Il promemoria del giorno prima non esiste: tolgo la frase che lo prometteva dai testi già salvati
UPDATE settings
   SET value = jsonb_set(value, '{wa_confirmed}', to_jsonb(btrim(regexp_replace(value->>'wa_confirmed', '\s*Ti mandiamo un promemoria il giorno prima\.', '', 'g'), E' \n')))
 WHERE key = 'messages' AND value->>'wa_confirmed' LIKE '%Ti mandiamo un promemoria il giorno prima.%';

UPDATE settings
   SET value = jsonb_set(value, '{mail_confirmed}', to_jsonb(btrim(regexp_replace(value->>'mail_confirmed', '\s*Riceverai un promemoria il giorno prima\.', '', 'g'), E' \n')))
 WHERE key = 'messages' AND value->>'mail_confirmed' LIKE '%Riceverai un promemoria il giorno prima.%';
