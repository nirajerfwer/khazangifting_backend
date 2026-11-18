import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config({
  path: ".env.development",
});

// Never log DATABASE_URL: it contains the database password.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Hosted Postgres (Neon) requires TLS. DATABASE_SSL=false allows a local Postgres without TLS.
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  // Fail fast instead of hanging forever if every connection is checked out.
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  // An idle client erroring (e.g. the server closed the connection) must not crash the process.
  console.error("Postgres pool error:", err.message);
});

// Runs fn inside BEGIN/COMMIT on one dedicated connection and releases it before returning.
// Callers must do any further pool work (audit logs, read-backs) AFTER this resolves: calling
// pool.query while still holding a transaction client can deadlock the pool under load, since
// every request would hold one connection while waiting for another.
export const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
