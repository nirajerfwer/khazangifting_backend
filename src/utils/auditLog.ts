import { pool } from "../database/db";

export const recordAuditLog = async (
  userId: string | undefined,
  action: string,
  entity: string,
  entityId: string | number | undefined,
  metadata?: Record<string, unknown>
) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
      [userId ?? null, action, entity, entityId != null ? String(entityId) : null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (error) {
    console.error("Failed to record audit log:", error);
  }
};
