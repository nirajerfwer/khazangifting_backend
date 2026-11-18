import { pool } from "./db";
import { runAdminMigration } from "./adminMigration";

export const setupDatabase = async () => {
  try {
    console.log("⏳ Setting up database...");

    // Enable UUID extension
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);

    // USERS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100),
        email VARCHAR(150) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration: these columns were added after the table may already have existed in
    // production — CREATE TABLE IF NOT EXISTS above is a no-op on an existing table,
    // so pre-existing installs need them backfilled explicitly.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'STAFF', 'CUSTOMER'));
        END IF;
      END
      $$;
    `);

    // CATEGORIES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(150) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS slug VARCHAR(150);`);

    // PRODUCTS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(100) UNIQUE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        stock INT DEFAULT 0,
        category_id INT REFERENCES categories(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(100);`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories(id);`);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_sku_key') THEN
          ALTER TABLE products ADD CONSTRAINT products_sku_key UNIQUE (sku);
        END IF;
      END
      $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_slug_key') THEN
          ALTER TABLE categories ADD CONSTRAINT categories_slug_key UNIQUE (slug);
        END IF;
      END
      $$;
    `);

    // PRODUCTS CATEGORIES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_categories (
          product_id int REFERENCES products(id) ON DELETE CASCADE,
          category_id INT REFERENCES categories(id) ON DELETE CASCADE,
          PRIMARY KEY (product_id, category_id)
      );
    `);

    // PRODUCT IMAGES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id) ON DELETE CASCADE,
        s3_key TEXT NOT NULL,
        image_url TEXT NOT NULL,
        alt_text VARCHAR(255),
        sort_order INT DEFAULT 0,
        is_primary BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration: add s3_key to product_images if the table pre-existed without it
    await pool.query(`
      ALTER TABLE product_images ADD COLUMN IF NOT EXISTS s3_key TEXT;
    `);
    // The live product_images table predates these columns (it only had id, product_id,
    // image_url, s3_key); the image admin and all storefront image queries rely on them.
    await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS alt_text VARCHAR(255);`);
    await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    // ORDERS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        total_amount NUMERIC(10,2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING_PAYMENT',
        shipping_address JSONB NOT NULL,
        razorpay_order_id VARCHAR(100) UNIQUE,
        razorpay_payment_id VARCHAR(100) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check'
        ) THEN
          ALTER TABLE orders ADD CONSTRAINT orders_status_check
            CHECK (status IN ('PENDING_PAYMENT','PAID','PROCESSING','PACKED','SHIPPED','DELIVERED','CANCELLED','REFUNDED'));
        END IF;
      END
      $$;
    `);

    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(100) UNIQUE;
    `);
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(100) UNIQUE;
    `);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
    await pool.query(`ALTER TABLE orders ALTER COLUMN total_amount SET NOT NULL;`).catch(() => {});

    // ORDER ITEMS — price is a snapshot of the product price at order time
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        product_id INT REFERENCES products(id),
        product_name VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        price NUMERIC(10,2) NOT NULL
      );
    `);

    // ORDER STATUS HISTORY — audit trail for admin status changes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_status_history (
        id SERIAL PRIMARY KEY,
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        changed_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    //cart
    await pool.query(`
      CREATE TABLE IF NOT EXISTS carts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
    `);

    //cart items
  await pool.query(`
            
  CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      cart_id UUID REFERENCES carts(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cart_id, product_id) -- prevents duplicate entries
  );
      `);
    //whishlist

    await pool.query(`
      
      CREATE TABLE IF NOT EXISTS wishlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
      `);

      //whishlist items

      await pool.query(`

        CREATE TABLE IF NOT EXISTS wishlist_items (
    id SERIAL PRIMARY KEY,
    wishlist_id UUID REFERENCES wishlists(id) ON DELETE CASCADE,
    product_id INT REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wishlist_id, product_id)
);
        `);

        //product_bulk_pricing

      await pool.query(`

        CREATE TABLE IF NOT EXISTS product_bulk_pricing (
  id SERIAL PRIMARY KEY,
  product_id int REFERENCES products(id) ON DELETE CASCADE,
  min_quantity INT NOT NULL,              -- e.g. 50, 100, 500
  price_per_unit NUMERIC(10,2) NOT NULL, -- e.g. 749.00
  discount_percent NUMERIC(5,2),         -- e.g. 17.00 (for "Save 17%")
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
        `);


      // MINIMUM ORDER QUANTITY
await pool.query(`
  CREATE TABLE IF NOT EXISTS product_moq (
    id SERIAL PRIMARY KEY,
    product_id INT REFERENCES products(id) ON DELETE CASCADE UNIQUE,
    min_quantity INT NOT NULL DEFAULT 1,
    moq_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);


    // BLOGS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blogs (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        excerpt TEXT,
        content TEXT,
        cover_image TEXT,
        author_id UUID REFERENCES users(id),
        published BOOLEAN NOT NULL DEFAULT FALSE,
        published_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE blogs ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES users(id);`);
    await pool.query(`ALTER TABLE blogs ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE blogs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    // PASSWORD RESET TOKENS — store a hash of the token, never the raw value
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
    `);

    // ADDRESSES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        full_name VARCHAR(150) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        line1 VARCHAR(255) NOT NULL,
        line2 VARCHAR(255),
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        pincode VARCHAR(20) NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // AUDIT LOGS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        entity VARCHAR(100) NOT NULL,
        entity_id VARCHAR(100),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ─── E-COMMERCE MIGRATION (cart / wishlist / checkout) ─────────────────────
    // Additive and idempotent: safe to re-run on an existing database.

    // Products: soft-deactivation, per-product inventory tracking, compare-at price for discounts.
    // track_inventory defaults to FALSE so existing products (imported with stock = 0) remain
    // purchasable as made-to-order; admins opt individual products into stock enforcement.
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS compare_at_price NUMERIC(10,2);`);
    await pool.query(`UPDATE products SET stock = 0 WHERE stock IS NULL OR stock < 0;`);
    await pool.query(`ALTER TABLE products ALTER COLUMN stock SET DEFAULT 0;`);
    await pool.query(`ALTER TABLE products ALTER COLUMN stock SET NOT NULL;`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_nonnegative') THEN
          ALTER TABLE products ADD CONSTRAINT products_stock_nonnegative CHECK (stock >= 0);
        END IF;
      END
      $$;
    `);

    // One cart / one wishlist per user. Merge any historical duplicates first so the unique
    // constraint can be created, then rely on it for atomic get-or-create (ON CONFLICT).
    await pool.query(`
      WITH ranked AS (
        SELECT id, user_id, FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at, id) AS keep_id
        FROM carts WHERE user_id IS NOT NULL
      )
      INSERT INTO cart_items (cart_id, product_id, quantity)
      SELECT r.keep_id, ci.product_id, ci.quantity FROM cart_items ci JOIN ranked r ON r.id = ci.cart_id
      WHERE r.id <> r.keep_id
      ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = GREATEST(cart_items.quantity, EXCLUDED.quantity);
    `);
    await pool.query(`
      DELETE FROM carts c USING carts k
      WHERE c.user_id = k.user_id AND (c.created_at, c.id::text) > (k.created_at, k.id::text);
    `);
    await pool.query(`
      WITH ranked AS (
        SELECT id, user_id, FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at, id) AS keep_id
        FROM wishlists WHERE user_id IS NOT NULL
      )
      INSERT INTO wishlist_items (wishlist_id, product_id)
      SELECT r.keep_id, wi.product_id FROM wishlist_items wi JOIN ranked r ON r.id = wi.wishlist_id
      WHERE r.id <> r.keep_id
      ON CONFLICT (wishlist_id, product_id) DO NOTHING;
    `);
    await pool.query(`
      DELETE FROM wishlists w USING wishlists k
      WHERE w.user_id = k.user_id AND (w.created_at, w.id::text) > (k.created_at, k.id::text);
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_carts_user ON carts(user_id);`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wishlists_user ON wishlists(user_id);`);

    await pool.query(`DELETE FROM cart_items WHERE quantity IS NULL OR quantity <= 0;`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_quantity_positive') THEN
          ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0);
        END IF;
      END
      $$;
    `);

    // Orders: price breakdown, payment status, billing address, idempotent creation.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_amount NUMERIC(10,2) NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'PENDING';`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address JSONB;`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key UUID;`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check') THEN
          ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
            CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED'));
        END IF;
      END
      $$;
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_idempotency ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`);

    // Order items: the live table was created with product_id as UUID, but products.id is an
    // integer. Convert it only while the table is empty; with existing rows, stop loudly
    // rather than guess at a data conversion.
    await pool.query(`
      DO $$
      BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'product_id') = 'uuid' THEN
          IF EXISTS (SELECT 1 FROM order_items) THEN
            RAISE EXCEPTION 'order_items.product_id is UUID and the table has rows; convert it manually to INT before running this migration';
          END IF;
          ALTER TABLE order_items ALTER COLUMN product_id TYPE INT USING NULL;
        END IF;
      END
      $$;
    `);

    // Order items: the live table predates product_name; add the snapshot columns.
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(255);`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sku VARCHAR(100);`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS inventory_tracked BOOLEAN NOT NULL DEFAULT FALSE;`);

    // Admin panel schema (brands, category tree, catalog fields, inventory ledger, refunds).
    await runAdminMigration(pool);

    // INDEXES
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cart_items_product ON cart_items(product_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wishlist_items_product ON wishlist_items(product_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, is_primary DESC, sort_order);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_categories_category ON product_categories(category_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_bulk_pricing_product ON product_bulk_pricing(product_id, min_quantity);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(is_active, created_at DESC);`);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blogs_published ON blogs(published, published_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blogs_slug ON blogs(slug);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `);

    //trigger

    await pool.query(`
                CREATE OR REPLACE FUNCTION update_updated_at_column()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.updated_at = NOW();
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
            `);
    //product
    //#

                await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                SELECT 1 FROM pg_trigger 
                WHERE tgname = 'trigger_update_products_updated_at'
                ) THEN
                CREATE TRIGGER trigger_update_products_updated_at
                BEFORE UPDATE ON products
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
                END IF;
            END
            $$;
            `);
    //#

    //user

        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                SELECT 1 FROM pg_trigger 
                WHERE tgname = 'trigger_update_users_updated_at'
                ) THEN
                CREATE TRIGGER trigger_update_users_updated_at
                BEFORE UPDATE ON users
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
                END IF;
            END
            $$;
            `);


    console.log("✅ Database setup complete!");
  } catch (error) {
    console.error("❌ Error setting up database:", error);
    // Non-zero exit so CI/deploy scripts notice a failed migration.
    process.exitCode = 1;
  }
};

setupDatabase().then(() => process.exit());
