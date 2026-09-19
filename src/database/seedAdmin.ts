import bcrypt from "bcryptjs";
import { pool } from "./db";

// Creates (or promotes) a SUPER_ADMIN account so there's a way into /admin routes
// without going through the public /register endpoint, which always assigns CUSTOMER.
// Override via env vars; falls back to a documented dev-only default otherwise.
const email = process.env.SEED_ADMIN_EMAIL || "admin@khazanagifting.com";
const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const name = process.env.SEED_ADMIN_NAME || "Khazana Admin";

const seedAdmin = async () => {
  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);

    if (existing.rows.length > 0) {
      await pool.query(
        "UPDATE users SET password=$1, role='SUPER_ADMIN', is_active=TRUE, updated_at=NOW() WHERE email=$2",
        [passwordHash, email]
      );
      console.log(`Updated existing user ${email} to SUPER_ADMIN.`);
    } else {
      await pool.query(
        "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, 'SUPER_ADMIN')",
        [name, email, passwordHash]
      );
      console.log(`Created SUPER_ADMIN user ${email}.`);
    }

    console.log("Login with:");
    console.log(`  email:    ${email}`);
    console.log(`  password: ${password}`);
    console.log("Change this password immediately after first login.");
  } catch (error) {
    console.error("Failed to seed admin:", error);
  } finally {
    await pool.end();
  }
};

seedAdmin();
