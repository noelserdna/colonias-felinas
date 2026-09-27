import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DB } from "./db";
import { schema } from "./db";
import type { Settings } from "./settings";
import { uuid } from "./util";
import { caducidad } from "./carnet-vigencia";
import { getTemarioActivoId } from "./temarios";

export { addMonths, caducidad, carnetStatus, esIndefinido, SIN_CADUCIDAD, textoCaducidad } from "./carnet-vigencia";

export function carnetNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}

export async function getActiveCarnet(db: DB, userId: string, now = new Date()) {
  return db.query.carnets.findFirst({
    where: and(eq(schema.carnets.userId, userId), isNull(schema.carnets.revokedAt), gt(schema.carnets.expiresAt, now)),
    orderBy: desc(schema.carnets.issuedAt),
  });
}

export async function getLatestCarnet(db: DB, userId: string) {
  return db.query.carnets.findFirst({ where: eq(schema.carnets.userId, userId), orderBy: desc(schema.carnets.issuedAt) });
}

async function nextSeq(db: DB, key: string): Promise<number> {
  const rows = await db.all<{ value: number }>(
    sql`INSERT INTO counters (key, value) VALUES (${key}, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value`,
  );
  return rows[0].value;
}

/** Emite el carnet (si no tiene ya uno vigente). `temarioId`: temario con el que se acredita (por defecto, el activo). */
export async function issueCarnet(db: DB, userId: string, attemptId: string | null, s: Settings, temarioId?: string | null) {
  const active = await getActiveCarnet(db, userId);
  if (active) return active;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user?.nombre || !user.apellidos) throw new Error("Perfil incompleto");
  const now = new Date();
  const year = now.getFullYear();
  const seq = await nextSeq(db, `carnet-${year}`);
  const row = {
    id: uuid(),
    numero: carnetNumber(s.carnet_prefix, year, seq),
    userId,
    nombre: user.nombre,
    apellidos: user.apellidos,
    issuedAt: now,
    expiresAt: caducidad(now, s.carnet_validity_months),
    attemptId,
    temarioId: temarioId ?? (await getTemarioActivoId(db)),
  };
  await db.insert(schema.carnets).values(row);
  return { ...row, revokedAt: null };
}
