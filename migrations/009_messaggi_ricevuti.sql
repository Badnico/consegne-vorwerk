-- Messaggi scritti dai clienti: testo e "letto" per il pannello
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_delivery_created ON messages (delivery_id, created_at);
