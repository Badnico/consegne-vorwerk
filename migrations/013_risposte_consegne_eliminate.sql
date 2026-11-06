-- Dati essenziali delle consegne eliminate: servono a riconoscere le risposte che arrivano dopo l'eliminazione
CREATE TABLE IF NOT EXISTS deleted_deliveries (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_ref     text,
  customer_name text,
  phone_e164    text,
  address       text,
  product       text,
  import_file   text,
  status        text,
  deleted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deleted_deliveries_phone ON deleted_deliveries (phone_e164, deleted_at DESC);
CREATE INDEX IF NOT EXISTS deleted_deliveries_tenant ON deleted_deliveries (tenant_id, deleted_at DESC);

-- Risposte e messaggi dei clienti arrivati per consegne non più presenti
CREATE TABLE IF NOT EXISTS late_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id   uuid,
  provider_id   text UNIQUE,
  from_phone    text NOT NULL,
  answer        text,
  body          text NOT NULL,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  seen_at       timestamptz
);
CREATE INDEX IF NOT EXISTS late_replies_tenant ON late_replies (tenant_id, created_at DESC);
