-- Demo seed. Apply with: npx wrangler d1 execute furvet --local --file=seed.sql  (or --remote)
-- Prices are PLACEHOLDERS (0). The app refuses to charge an item priced 0 and /health
-- reports catalog_unpriced=true until the clinic's real prices are set:
--   UPDATE catalog_items SET price_cents = 45000 WHERE sku = 'CONSULTA-GENERAL';
INSERT INTO catalog_items (id, sku, name, category, price_cents, unit) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'ANTICIPO-CONSULTA', 'Anticipo de consulta', 'anticipo', 0, 'pza'),
  ('c0000000-0000-4000-8000-000000000002', 'CONSULTA-GENERAL', 'Consulta general', 'consulta', 0, 'pza'),
  ('c0000000-0000-4000-8000-000000000003', 'VAC-SEXTUPLE', 'Vacuna séxtuple (perro)', 'vacunacion', 0, 'dosis'),
  ('c0000000-0000-4000-8000-000000000004', 'VAC-RABIA', 'Vacuna antirrábica', 'vacunacion', 0, 'dosis'),
  ('c0000000-0000-4000-8000-000000000005', 'VAC-TRIPLE-FELINA', 'Vacuna triple felina', 'vacunacion', 0, 'dosis'),
  ('c0000000-0000-4000-8000-000000000006', 'DESPARASITANTE', 'Desparasitación interna', 'desparasitacion', 0, 'dosis'),
  ('c0000000-0000-4000-8000-000000000007', 'MED-AMOXICILINA', 'Amoxicilina (tableta)', 'medicamento', 0, 'tableta'),
  ('c0000000-0000-4000-8000-000000000008', 'MED-MELOXICAM', 'Meloxicam (tableta)', 'medicamento', 0, 'tableta'),
  ('c0000000-0000-4000-8000-000000000009', 'MED-OMEPRAZOL', 'Omeprazol (cápsula)', 'medicamento', 0, 'cápsula'),
  ('c0000000-0000-4000-8000-000000000010', 'MED-METRONIDAZOL', 'Metronidazol (tableta)', 'medicamento', 0, 'tableta'),
  ('c0000000-0000-4000-8000-000000000011', 'MED-OTICO', 'Gotas óticas (frasco)', 'medicamento', 0, 'frasco');

-- Ten future slots, weekdays-agnostic, 30 min each. Stored in UTC; 16:00Z = 10:00 America/Mexico_City (UTC-6, no DST).
INSERT INTO slots (id, starts_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', strftime('%Y-%m-%dT16:00:00Z', 'now', '+1 day')),
  ('a0000000-0000-4000-8000-000000000002', strftime('%Y-%m-%dT16:30:00Z', 'now', '+1 day')),
  ('a0000000-0000-4000-8000-000000000003', strftime('%Y-%m-%dT17:00:00Z', 'now', '+1 day')),
  ('a0000000-0000-4000-8000-000000000004', strftime('%Y-%m-%dT22:00:00Z', 'now', '+1 day')),
  ('a0000000-0000-4000-8000-000000000005', strftime('%Y-%m-%dT22:30:00Z', 'now', '+1 day')),
  ('a0000000-0000-4000-8000-000000000006', strftime('%Y-%m-%dT16:00:00Z', 'now', '+2 days')),
  ('a0000000-0000-4000-8000-000000000007', strftime('%Y-%m-%dT16:30:00Z', 'now', '+2 days')),
  ('a0000000-0000-4000-8000-000000000008', strftime('%Y-%m-%dT17:00:00Z', 'now', '+2 days')),
  ('a0000000-0000-4000-8000-000000000009', strftime('%Y-%m-%dT22:00:00Z', 'now', '+2 days')),
  ('a0000000-0000-4000-8000-000000000010', strftime('%Y-%m-%dT22:30:00Z', 'now', '+2 days'));
