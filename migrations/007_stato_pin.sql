-- Nuovo stato: il cliente ha detto Sì e deve rispondere "Hai ricevuto il PIN?"
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'pin_check';
