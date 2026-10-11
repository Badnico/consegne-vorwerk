-- Funzioni extra attivabili per singolo ambiente dal pannello amministratore
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}';
-- Report Excel a orario fisso: attivo per l'ambiente "gigi"
UPDATE tenants SET features = features || '{"reportAtTime": true}' WHERE slug = 'gigi';
