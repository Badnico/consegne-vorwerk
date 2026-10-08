-- Schema iniziale: fasce, slot con capienza, consegne, link cliente, messaggi, storico.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE delivery_status AS ENUM (
  'proposed',       -- messaggio inviato, posto già occupato
  'confirmed',      -- il cliente ha detto Sì
  'to_reschedule',  -- il cliente ha detto No, posto liberato, link inviato
  'rescheduled',    -- il cliente ha scelto un nuovo slot
  'no_response',    -- nessuna risposta: passa all'operatore
  'cancelled',
  'delivered'
);

-- Fasce ricorrenti per giorno della settimana (0 = domenica ... 6 = sabato)
CREATE TABLE slot_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  capacity    integer NOT NULL CHECK (capacity >= 0),
  active      boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time),
  UNIQUE (weekday, start_time, end_time)
);

-- Eccezioni per una data: capacity = 0 chiude la fascia (festivi, ferie)
CREATE TABLE slot_overrides (
  date        date NOT NULL,
  template_id uuid NOT NULL REFERENCES slot_templates(id) ON DELETE CASCADE,
  capacity    integer NOT NULL CHECK (capacity >= 0),
  PRIMARY KEY (date, template_id)
);

-- Slot concreti. "booked" cambia solo con UPDATE condizionati (vedi src/domain/slots.ts).
-- Niente CHECK booked <= capacity: la capienza può essere ridotta dall'operatore
-- sotto le prenotazioni esistenti; il sistema lo segnala invece di bloccare.
CREATE TABLE slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  template_id uuid REFERENCES slot_templates(id) ON DELETE SET NULL,
  capacity    integer NOT NULL CHECK (capacity >= 0),
  booked      integer NOT NULL DEFAULT 0 CHECK (booked >= 0),
  UNIQUE (date, start_time, end_time)
);
CREATE INDEX slots_date_idx ON slots (date);

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  phone_e164       text,
  email            text,
  consent_whatsapp boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref        text NOT NULL UNIQUE,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  address          text NOT NULL,
  product          text,
  slot_id          uuid REFERENCES slots(id),
  proposed_slot_id uuid NOT NULL REFERENCES slots(id),
  status           delivery_status NOT NULL DEFAULT 'proposed',
  reminders_sent   integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_slot_idx ON deliveries (slot_id);
CREATE INDEX deliveries_status_idx ON deliveries (status);

-- Link personali: nel database solo l'hash del token
CREATE TABLE access_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid REFERENCES deliveries(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  direction   text NOT NULL CHECK (direction IN ('out', 'in')),
  kind        text NOT NULL,             -- proposal, reminder, reschedule_link, confirmation, reply
  provider_id text UNIQUE,               -- id Meta / Message-ID email: deduplica i webhook
  status      text NOT NULL DEFAULT 'queued',
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_events (
  id          bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  from_status delivery_status,
  to_status   delivery_status NOT NULL,
  actor       text NOT NULL,             -- customer, operator:<id>, system
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_delivery_idx ON delivery_events (delivery_id);
