-- Futura Service resta con il portale com'era prima della scheda "Funzioni Extra":
-- stessa scheda "Area servita", casella "Invia sia su WhatsApp sia per email" in Nuova consegna, niente gruppi di città.
-- Le altre aziende (e quelle create da ora in poi) hanno il portale nuovo.
UPDATE tenants SET features = coalesce(features, '{}'::jsonb) || '{"legacyLayout": true}'::jsonb WHERE slug = 'futura-service';
