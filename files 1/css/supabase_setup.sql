-- =============================================================
--  SUPABASE SETUP SQL — CMDA-NAUTH ERP
--  Run this entire script in: Supabase → SQL Editor → Run
-- =============================================================

-- 1. KEY-VALUE store tables (each row = one store's entire dataset)
CREATE TABLE IF NOT EXISTS erp_biz (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS erp_staff (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS erp_inv (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS erp_sales (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS erp_acc (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS erp_purch (
    store_id TEXT PRIMARY KEY,
    value    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS erp_finance (
    store_id TEXT PRIMARY KEY,
    value    NUMERIC NOT NULL DEFAULT 0
);

-- 2. Chat messages (one row per message)
CREATE TABLE IF NOT EXISTS erp_chat (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    staff_id   TEXT,
    name       TEXT,
    text       TEXT,
    avatar     TEXT
);

-- 3. Staff presence (one row per staff member)
CREATE TABLE IF NOT EXISTS erp_presence (
    staff_id  TEXT PRIMARY KEY,
    online    BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name      TEXT
);

-- =============================================================
--  ENABLE ROW LEVEL SECURITY
-- =============================================================
ALTER TABLE erp_biz      ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_staff    ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_inv      ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_sales    ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_acc      ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_purch    ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_finance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_chat     ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_presence ENABLE ROW LEVEL SECURITY;

-- =============================================================
--  RLS POLICIES — allow anon (public) full access
--  ⚠️  Tighten these for production by adding auth checks
-- =============================================================
CREATE POLICY "anon_all" ON erp_biz      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_staff    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_inv      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_sales    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_acc      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_purch    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_finance  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_chat     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON erp_presence FOR ALL TO anon USING (true) WITH CHECK (true);

-- =============================================================
--  INSERT SEED ROW for store_1 (prevents "row not found" on
--  first load before any data has been saved)
-- =============================================================
INSERT INTO erp_biz      (store_id, value) VALUES ('store_1', '{}')       ON CONFLICT DO NOTHING;
INSERT INTO erp_staff    (store_id, value) VALUES ('store_1', '[]')       ON CONFLICT DO NOTHING;
INSERT INTO erp_inv      (store_id, value) VALUES ('store_1', '[]')       ON CONFLICT DO NOTHING;
INSERT INTO erp_sales    (store_id, value) VALUES ('store_1', '[]')       ON CONFLICT DO NOTHING;
INSERT INTO erp_acc      (store_id, value) VALUES ('store_1', '[]')       ON CONFLICT DO NOTHING;
INSERT INTO erp_purch    (store_id, value) VALUES ('store_1', '[]')       ON CONFLICT DO NOTHING;
INSERT INTO erp_finance  (store_id, value) VALUES ('store_1', 0)          ON CONFLICT DO NOTHING;

-- Done! ✅
