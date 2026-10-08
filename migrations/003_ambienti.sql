-- Più clienti (ambienti) nello stesso sistema: ognuno con dati, fasce, area e testi propri.

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name             text NOT NULL,
  email            text NOT NULL,
  subscription_end date NOT NULL,
  suspended        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- I dati già presenti (installazione precedente) finiscono nell'ambiente "vorwerk"
INSERT INTO tenants (slug, name, email, subscription_end)
SELECT 'vorwerk', 'Vorwerk', COALESCE((SELECT email FROM operators ORDER BY created_at LIMIT 1), 'admin@example.it'), current_date + 365
WHERE EXISTS (SELECT 1 FROM slot_templates) OR EXISTS (SELECT 1 FROM deliveries) OR EXISTS (SELECT 1 FROM settings);

ALTER TABLE slot_templates ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE slots          ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE customers      ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE deliveries     ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE settings       ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE slot_templates SET tenant_id = (SELECT id FROM tenants WHERE slug = 'vorwerk');
UPDATE slots          SET tenant_id = (SELECT id FROM tenants WHERE slug = 'vorwerk');
UPDATE customers      SET tenant_id = (SELECT id FROM tenants WHERE slug = 'vorwerk');
UPDATE deliveries     SET tenant_id = (SELECT id FROM tenants WHERE slug = 'vorwerk');
UPDATE settings       SET tenant_id = (SELECT id FROM tenants WHERE slug = 'vorwerk');

ALTER TABLE slot_templates ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE slots          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE customers      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE deliveries     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE settings       ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE slot_templates DROP CONSTRAINT IF EXISTS slot_templates_weekday_start_time_end_time_key;
ALTER TABLE slot_templates ADD CONSTRAINT slot_templates_tenant_band_key UNIQUE (tenant_id, weekday, start_time, end_time);
ALTER TABLE slots DROP CONSTRAINT IF EXISTS slots_date_start_time_end_time_key;
ALTER TABLE slots ADD CONSTRAINT slots_tenant_date_band_key UNIQUE (tenant_id, date, start_time, end_time);
CREATE INDEX slots_tenant_date_idx ON slots (tenant_id, date);
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_order_ref_key;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_tenant_order_key UNIQUE (tenant_id, order_ref);
CREATE INDEX deliveries_tenant_idx ON deliveries (tenant_id);
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (tenant_id, key);

-- Operatori: il superamministratore (tu) non ha ambiente; gli utenti dei clienti sì
ALTER TABLE operators ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE operators ADD COLUMN username text;
UPDATE operators SET username = email;
ALTER TABLE operators ALTER COLUMN username SET NOT NULL;
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
UPDATE operators SET role = 'superadmin' WHERE tenant_id IS NULL;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('superadmin', 'admin', 'operator'));
ALTER TABLE operators ADD CONSTRAINT operators_role_tenant CHECK ((role = 'superadmin') = (tenant_id IS NULL));
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_email_key;
CREATE UNIQUE INDEX operators_superadmin_email ON operators (lower(email)) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX operators_tenant_username ON operators (tenant_id, lower(username)) WHERE tenant_id IS NOT NULL;

-- Le sessioni esistenti erano del vecchio pannello: si rientra
DELETE FROM sessions;
