-- Nome del profilo WhatsApp di chi scrive (arriva insieme al messaggio)
ALTER TABLE late_replies ADD COLUMN IF NOT EXISTS wa_name text;

-- Nomi riconosciuti da un file Excel caricato dall'azienda (per le risposte a consegne eliminate)
CREATE TABLE IF NOT EXISTS late_reply_names (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164  text NOT NULL,
  name        text NOT NULL,
  order_ref   text,
  address     text,
  source_file text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_e164)
);
