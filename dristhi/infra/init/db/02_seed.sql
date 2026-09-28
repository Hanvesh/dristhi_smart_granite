-- Real granite-bearing regions of Andhra Pradesh (approx district centroids).
INSERT INTO quarries (quarry_id, name, district, location) VALUES
  ('APQRY-0023', 'Amaravati Granite Quarry', 'Guntur',    ST_GeogFromText('POINT(80.3567 16.5734)')),
  ('APQRY-0041', 'Ongole Black Galaxy Unit', 'Prakasam',  ST_GeogFromText('POINT(80.0447 15.5057)')),
  ('APQRY-0058', 'Chimakurthy Galaxy Belt',  'Prakasam',  ST_GeogFromText('POINT(79.8665 15.5793)')),
  ('APQRY-0072', 'Srikakulam Blue Quarry',   'Srikakulam',ST_GeogFromText('POINT(83.8974 18.2969)')),
  ('APQRY-0089', 'Anantapur Grey Unit',      'Anantapur', ST_GeogFromText('POINT(77.6006 14.6819)')),
  ('APQRY-0104', 'Kurnool Pink Belt',        'Kurnool',   ST_GeogFromText('POINT(78.0373 15.8281)'))
ON CONFLICT (quarry_id) DO NOTHING;

INSERT INTO robots (robot_id, name, status, battery_percent, waypoint, blocks_measured, home_quarry, last_gps, last_seen) VALUES
  ('DRISHTI-BOT-01', 'Surveyor 1', 'idle',     82, 'dock',        47, 'APQRY-0023', ST_GeogFromText('POINT(80.3567 16.5734)'), now()),
  ('DRISHTI-BOT-02', 'Surveyor 2', 'charging', 45, 'charge-dock', 12, 'APQRY-0041', ST_GeogFromText('POINT(80.0447 15.5057)'), now()),
  ('DRISHTI-BOT-03', 'Surveyor 3', 'idle',     90, 'dock',         5, 'APQRY-0072', ST_GeogFromText('POINT(83.8974 18.2969)'), now())
ON CONFLICT (robot_id) DO NOTHING;

-- Granite blocks laid out in rows across each quarry pit, GPS-tagged. The home
-- quarry (APQRY-0023) gets 12 blocks; the rest get 8 each.
DO $$
DECLARE
  mdeg double precision := 111320.0;
  dims double precision[][] := ARRAY[
    ARRAY[2.34,1.12,0.87], ARRAY[3.10,1.55,1.30], ARRAY[1.90,0.95,0.70],
    ARRAY[2.72,1.28,1.05], ARRAY[3.45,1.62,1.42], ARRAY[2.05,1.05,0.80],
    ARRAY[2.90,1.40,1.15], ARRAY[1.75,0.90,0.65], ARRAY[3.25,1.50,1.35],
    ARRAY[2.50,1.20,0.95], ARRAY[3.60,1.70,1.50], ARRAY[2.18,1.08,0.82]
  ];
  statuses text[] := ARRAY['approved','pending','approved','flagged','pending','approved',
                           'pending','approved','flagged','pending','approved','pending'];
  cats text[] := ARRAY['black_galaxy','srikakulam_blue','generic'];
  rates double precision[] := ARRAY[2000.0,1500.0,1200.0];
  qids text[]  := ARRAY['APQRY-0023','APQRY-0041','APQRY-0058','APQRY-0072','APQRY-0089','APQRY-0104'];
  codes text[] := ARRAY['AMR','ONG','CHM','SKL','ATP','KNL'];
  qlat double precision[] := ARRAY[16.5734,15.5057,15.5793,18.2969,14.6819,15.8281];
  qlon double precision[] := ARRAY[80.3567,80.0447,79.8665,83.8974,77.6006,78.0373];
  q int; nblocks int; i int; row_i int; col_i int; cols int := 4; gap double precision := 28;
  east double precision; north double precision; blat double precision; blon double precision;
  L double precision; W double precision; H double precision; vol double precision;
  cls text; cat text; rate double precision; fee double precision; bid text;
BEGIN
  FOR q IN 1..6 LOOP
    nblocks := CASE WHEN q = 1 THEN 12 ELSE 8 END;
    FOR i IN 0..(nblocks - 1) LOOP
      row_i := i / cols; col_i := i % cols;
      east := (col_i - (cols - 1) / 2.0) * gap;
      north := (row_i - 1) * gap - 10;
      blat := qlat[q] + north / mdeg;
      blon := qlon[q] + east / (mdeg * cos(radians(qlat[q])));
      L := dims[(i % 12)+1][1]; W := dims[(i % 12)+1][2]; H := dims[(i % 12)+1][3];
      vol := round((L * W * H)::numeric, 2);
      cls := CASE WHEN vol > 2.5 THEN 'above_gangsaw' ELSE 'below_gangsaw' END;
      cat := cats[(i % 3) + 1];
      rate := rates[(i % 3) + 1];
      fee := round((vol * rate * (CASE WHEN cls = 'above_gangsaw' THEN 1.25 ELSE 1.0 END))::numeric, 2);
      bid := 'QRY-' || codes[q] || '-2026-' || lpad((100 + i)::text, 4, '0');
      INSERT INTO blocks (block_id, quarry_id, gps, gps_accuracy_cm, length_m, width_m, height_m,
          volume_m3, confidence, measurement_method, classification, granite_category,
          seigniorage_fee_inr, source, status)
      VALUES (bid, qids[q],
          ST_GeogFromText('POINT(' || blon || ' ' || blat || ')'), 2,
          L, W, H, vol, round((0.86 + (i % 5) * 0.026)::numeric, 2), 'robot_stereo_pointcloud',
          cls, cat, fee, 'robot', statuses[(i % 12)+1])
      ON CONFLICT (block_id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO weighbridge_records (block_id, weight_mt) VALUES
  ('QRY-AMR-2026-0100', 6.4)
ON CONFLICT DO NOTHING;
