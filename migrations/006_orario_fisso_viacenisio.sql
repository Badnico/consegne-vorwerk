-- Report Excel a orario fisso anche per l'ambiente "viacenisio55a" (i nuovi ambienti lo hanno già attivo)
UPDATE tenants SET features = features || '{"reportAtTime": true}' WHERE slug = 'viacenisio55a';
