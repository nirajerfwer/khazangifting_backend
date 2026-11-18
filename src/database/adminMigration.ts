import { Pool } from "pg";

// Admin-panel schema (brands, category tree, product catalog fields, inventory ledger,
// order fulfilment/refund fields). Additive and idempotent: safe to re-run.
export const runAdminMigration = async (pool: Pool) => {
  // ── Brands ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      slug VARCHAR(180) NOT NULL UNIQUE,
      description TEXT,
      logo_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_name_lower ON brands (LOWER(name));`);

  // Shared slug helper used by triggers and backfills.
  await pool.query(`
    CREATE OR REPLACE FUNCTION khz_slugify(input TEXT) RETURNS TEXT AS $$
      SELECT NULLIF(TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(COALESCE(input, ''), '[^a-zA-Z0-9]+', '-', 'g'))), '');
    $$ LANGUAGE sql IMMUTABLE;
  `);

  // ── Category tree + metadata ────────────────────────────────────────────
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES categories(id) ON DELETE RESTRICT;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_title VARCHAR(255);`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_description TEXT;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
  // Backfill slugs (id suffix only where the plain slug would collide).
  await pool.query(`
    UPDATE categories c SET slug = CASE
      WHEN EXISTS (SELECT 1 FROM categories o WHERE o.id <> c.id AND (o.slug = khz_slugify(c.name) OR (o.slug IS NULL AND khz_slugify(o.name) = khz_slugify(c.name) AND o.id < c.id)))
      THEN COALESCE(khz_slugify(c.name), 'category') || '-' || c.id
      ELSE COALESCE(khz_slugify(c.name), 'category-' || c.id) END
    WHERE c.slug IS NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);`);

  // ── Product catalog fields ──────────────────────────────────────────────
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS slug VARCHAR(300);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id INT REFERENCES brands(id) ON DELETE RESTRICT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(50);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 5;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS status VARCHAR(20);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_title VARCHAR(255);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_description TEXT;`);

  await pool.query(`UPDATE products SET status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END WHERE status IS NULL;`);
  // Deliberately no column DEFAULT: a default would be applied before the sync trigger runs, so
  // an insert that only sets is_active=false would be forced ACTIVE. The trigger derives status
  // from is_active when none is given; NOT NULL is checked after BEFORE triggers.
  await pool.query(`ALTER TABLE products ALTER COLUMN status DROP DEFAULT;`);
  await pool.query(`ALTER TABLE products ALTER COLUMN status SET NOT NULL;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_status_check') THEN
        ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('DRAFT','ACTIVE','INACTIVE'));
      END IF;
    END
    $$;
  `);

  // Slug backfill: name-id is always unique, so no collision handling is needed.
  await pool.query(`UPDATE products SET slug = COALESCE(khz_slugify(name), 'product') || '-' || id WHERE slug IS NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_products_slug ON products(slug);`);

  // Keeps status (admin lifecycle) and is_active (storefront visibility) consistent no matter
  // which one a code path writes, and fills a slug for any insert path (e.g. the Excel import).
  await pool.query(`
    CREATE OR REPLACE FUNCTION khz_products_sync() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS NULL THEN NEW.status := CASE WHEN COALESCE(NEW.is_active, TRUE) THEN 'ACTIVE' ELSE 'INACTIVE' END; END IF;
        NEW.is_active := (NEW.status = 'ACTIVE');
        IF NEW.slug IS NULL OR NEW.slug = '' THEN NEW.slug := COALESCE(khz_slugify(NEW.name), 'product') || '-' || NEW.id; END IF;
      ELSE
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          NEW.is_active := (NEW.status = 'ACTIVE');
        ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
          NEW.status := CASE WHEN NEW.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END;
        END IF;
        IF NEW.slug IS NULL OR NEW.slug = '' THEN NEW.slug := COALESCE(khz_slugify(NEW.name), 'product') || '-' || NEW.id; END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_products_sync') THEN
        CREATE TRIGGER trigger_products_sync BEFORE INSERT OR UPDATE ON products
        FOR EACH ROW EXECUTE FUNCTION khz_products_sync();
      END IF;
    END
    $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_name_lower ON products(LOWER(name));`);

  // ── Inventory ledger ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id BIGSERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      change INT NOT NULL,
      stock_after INT NOT NULL,
      reason VARCHAR(30) NOT NULL,
      reference VARCHAR(100),
      note TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_movements_reason_check') THEN
        ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check
          CHECK (reason IN ('ADJUSTMENT','RESTOCK','DAMAGE','CORRECTION','ORDER','ORDER_CANCELLED','RETURN','INITIAL'));
      END IF;
    END
    $$;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_created ON inventory_movements(created_at DESC);`);

  // ── Orders: fulfilment, returns, refund records ─────────────────────────
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_restored BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(100);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier VARCHAR(100);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(100);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_note TEXT;`);
  await pool.query(`ALTER TABLE order_status_history ADD COLUMN IF NOT EXISTS note TEXT;`);
  // Widen the status set with RETURNED (replacing the constraint only adds an allowed value).
  await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;`);
  await pool.query(`
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('PENDING_PAYMENT','PAID','PROCESSING','PACKED','SHIPPED','DELIVERED','CANCELLED','RETURNED','REFUNDED'));
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);`);
};
