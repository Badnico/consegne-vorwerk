-- File Excel da cui arriva ogni consegna (per fare un report separato per ogni file caricato)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS import_file text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS source_file text;
