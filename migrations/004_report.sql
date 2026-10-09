-- Report Excel periodici per ambiente
CREATE TABLE IF NOT EXISTS reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  filename    text NOT NULL,
  rows        integer NOT NULL,
  counts      jsonb NOT NULL DEFAULT '{}',
  trigger     text NOT NULL DEFAULT 'auto',   -- auto | manual
  emailed_to  text,
  data        bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_tenant_created ON reports (tenant_id, created_at DESC);
