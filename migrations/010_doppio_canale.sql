-- Consegna da avvisare sia su WhatsApp sia per email (scelta in "Nuova consegna")
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS both_channels boolean NOT NULL DEFAULT false;
