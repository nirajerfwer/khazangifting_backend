import { pool } from "./db";

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

    // PRODUCTS CATEGORIES
    await pool.query(`
      CREATE TABLE product_categories (
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
        image_url TEXT NOT NULL,
        alt_text VARCHAR(255),
        sort_order INT DEFAULT 0,
        is_primary BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ORDERS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        total_amount NUMERIC(10,2),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ORDER ITEMS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        product_id INT REFERENCES products(id),
        quantity INT,
        price NUMERIC(10,2)
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

    // INDEXES
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
  }
};

setupDatabase().then(() => process.exit());
