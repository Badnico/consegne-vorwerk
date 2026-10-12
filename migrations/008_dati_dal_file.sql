-- Dati letti dal file Excel del cliente
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS city text;               -- località (es. ANDRANO)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS province text;           -- sigla provincia (es. LE)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cod_amount numeric(10,2) NOT NULL DEFAULT 0;  -- contrassegno da pagare
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS pickup boolean NOT NULL DEFAULT false;        -- ritiro del vecchio prodotto
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS source jsonb;            -- riga originale del file: [{h: intestazione, v: valore}]
