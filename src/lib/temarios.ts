// Temarios en la base de datos: temario activo, listado, alta/edición, exportación e importación de paquetes.
// La parte pura (validación, elección del activo, impacto de un cambio) está en temarios-config.ts.
import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "./db";
import * as schema from "./db/schema";
import {
  construirPaquete,
  elegirTemarioActivo,
  impactoCambio,
  TEMARIO_ACTIVO_KEY,
  temarioMeta,
  validarPaquete,
  type TemarioMeta,
} from "./temarios-config";

export type Temario = typeof schema.temarios.$inferSelect;
export type TemarioInfo = { id: string; nombre: string; credito: string | null };

// Con la tabla escrita a mano: drizzle pondría la columna sin tabla y dentro de la subconsulta se leería u.id.
const temasActivos = sql<number>`(SELECT count(*) FROM units u WHERE u.temario_id = "temarios"."id" AND u.activo = 1)`;

/** Consultas para saber el temario activo (se pueden meter en un db.batch con otras). */
export function temarioActivoQueries(db: DB) {
  return [
    db.select().from(schema.settings).where(eq(schema.settings.key, TEMARIO_ACTIVO_KEY)),
    db
      .select({ id: schema.temarios.id, nombre: schema.temarios.nombre, credito: schema.temarios.credito, oculto: schema.temarios.oculto, temasActivos })
      .from(schema.temarios)
      .orderBy(asc(schema.temarios.createdAt)),
  ] as const;
}

/** Temario activo a partir del resultado de `temarioActivoQueries`. */
export function temarioActivoFrom(
  setting: { value: unknown }[],
  temarios: { id: string; nombre: string; credito: string | null; oculto: boolean; temasActivos: number }[],
): TemarioInfo {
  const id = elegirTemarioActivo(setting[0]?.value, temarios.map((t) => ({ ...t, temasActivos: Number(t.temasActivos) })));
  const t = temarios.find((x) => x.id === id);
  return { id, nombre: t?.nombre ?? id, credito: t?.credito ?? null };
}

export async function getTemarioActivo(db: DB): Promise<TemarioInfo> {
  const [setting, temarios] = await db.batch(temarioActivoQueries(db));
  return temarioActivoFrom(setting, temarios);
}

export async function getTemarioActivoId(db: DB): Promise<string> {
  return (await getTemarioActivo(db)).id;
}

/** Temas activos del temario activo (o del indicado), por orden. */
export async function activeUnits(db: DB, temarioId?: string) {
  const id = temarioId ?? (await getTemarioActivoId(db));
  return db.query.units.findMany({ where: and(eq(schema.units.activo, true), eq(schema.units.temarioId, id)), orderBy: asc(schema.units.orden) });
}

/** Número de temas activos de un temario. */
export async function countActiveUnits(db: DB, temarioId: string) {
  const [{ n }] = await db.select({ n: count() }).from(schema.units).where(and(eq(schema.units.activo, true), eq(schema.units.temarioId, temarioId)));
  return n;
}

/** Tema activo del temario activo por su slug (los slugs solo son únicos dentro de cada temario). */
export async function findActiveUnitBySlug(db: DB, slug: string) {
  const id = await getTemarioActivoId(db);
  const unit = await db.query.units.findFirst({ where: and(eq(schema.units.temarioId, id), eq(schema.units.slug, slug)) });
  return unit?.activo ? unit : undefined;
}

export async function getTemario(db: DB, id: string) {
  return db.query.temarios.findFirst({ where: eq(schema.temarios.id, id) });
}

/** Temarios con sus recuentos de temas y preguntas (por tipo). */
export async function listTemarios(db: DB) {
  const [temarios, temas, preguntas] = await db.batch([
    db.select().from(schema.temarios).orderBy(asc(schema.temarios.createdAt)),
    db
      .select({ temarioId: schema.units.temarioId, activo: schema.units.activo, n: count() })
      .from(schema.units)
      .groupBy(schema.units.temarioId, schema.units.activo),
    db
      .select({ temarioId: schema.units.temarioId, type: schema.questions.type, n: count() })
      .from(schema.questions)
      .innerJoin(schema.units, eq(schema.units.id, schema.questions.unitId))
      .where(eq(schema.questions.activo, true))
      .groupBy(schema.units.temarioId, schema.questions.type),
  ]);
  const activoId = await getTemarioActivoId(db);
  return temarios.map((t) => {
    const u = temas.filter((x) => x.temarioId === t.id);
    const p = (tipo: string) => preguntas.filter((x) => x.temarioId === t.id && x.type === tipo).reduce((a, x) => a + x.n, 0);
    return {
      ...t,
      activo: t.id === activoId,
      temas: u.reduce((a, x) => a + x.n, 0),
      temasActivos: u.filter((x) => x.activo).reduce((a, x) => a + x.n, 0),
      preguntas: { mc: p("mc"), multi: p("multi"), written: p("written") },
    };
  });
}

/** Temarios para los selectores del panel: los visibles y, si se pide, uno oculto concreto. */
export async function temariosSelector(db: DB, incluir?: string) {
  const all = await db.select().from(schema.temarios).orderBy(asc(schema.temarios.createdAt));
  return all.filter((t) => !t.oculto || t.id === incluir);
}

/** Temario elegido en el panel (?temario=…) si existe; si no, el activo. */
export async function temarioElegido(db: DB, pedido: string | null | undefined): Promise<string> {
  if (pedido && (await getTemario(db, pedido))) return pedido;
  return getTemarioActivoId(db);
}

export class TemarioError extends Error {}

export async function crearTemario(db: DB, input: unknown) {
  const t = temarioMeta.parse(input);
  if (await getTemario(db, t.id)) throw new TemarioError(`Ya existe un temario con el identificador «${t.id}».`);
  const now = new Date();
  await db.insert(schema.temarios).values({ ...t, oculto: false, createdAt: now, updatedAt: now });
  return t.id;
}

export async function actualizarTemario(db: DB, id: string, input: unknown) {
  const t = temarioMeta.omit({ id: true }).parse(input);
  await db.update(schema.temarios).set({ ...t, updatedAt: new Date() }).where(eq(schema.temarios.id, id));
}

export async function ocultarTemario(db: DB, id: string, oculto: boolean) {
  if (oculto && (await getTemarioActivoId(db)) === id) throw new TemarioError("No se puede ocultar el temario activo: activa antes otro.");
  await db.update(schema.temarios).set({ oculto, updatedAt: new Date() }).where(eq(schema.temarios.id, id));
}

// ---------- Cambio de temario activo ----------

/** Datos del impacto de activar `destino` (ver `impactoCambio`). */
export async function impactoActivar(db: DB, destino: string, avisosCobertura: string[]) {
  const actual = await getTemarioActivoId(db);
  const now = new Date();
  const [[dest], conProgreso, [tests], [finales], [corrigiendo], [vigentes]] = await db.batch([
    db.select({ n: count() }).from(schema.units).where(and(eq(schema.units.temarioId, destino), eq(schema.units.activo, true))),
    db
      .selectDistinct({ userId: schema.attempts.userId })
      .from(schema.attempts)
      .innerJoin(schema.units, eq(schema.units.id, schema.attempts.unitId))
      .where(
        and(
          eq(schema.attempts.kind, "unit"),
          eq(schema.attempts.status, "passed"),
          eq(schema.units.temarioId, actual),
          sql`NOT EXISTS (SELECT 1 FROM carnets c WHERE c.user_id = ${schema.attempts.userId} AND c.revoked_at IS NULL AND c.expires_at > ${now.getTime()})`,
        ),
      ),
    db
      .select({ n: count() })
      .from(schema.attempts)
      .innerJoin(schema.units, eq(schema.units.id, schema.attempts.unitId))
      .where(and(eq(schema.attempts.kind, "unit"), eq(schema.attempts.status, "in_progress"), eq(schema.units.temarioId, actual))),
    db
      .select({ n: count() })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.kind, "final"), eq(schema.attempts.status, "in_progress"), eq(schema.attempts.temarioId, actual))),
    db.select({ n: count() }).from(schema.attempts).where(and(eq(schema.attempts.kind, "final"), eq(schema.attempts.status, "grading"))),
    db.select({ n: count() }).from(schema.carnets).where(and(isNull(schema.carnets.revokedAt), gt(schema.carnets.expiresAt, now))),
  ]);
  return {
    actual,
    ...impactoCambio({
      temasDestino: dest.n,
      avisosCobertura,
      personasConProgreso: conProgreso.length,
      testsEnCurso: tests.n,
      finalesEnCurso: finales.n,
      finalesEnCorreccion: corrigiendo.n,
      carnetsVigentes: vigentes.n,
    }),
  };
}

export async function activarTemario(db: DB, id: string) {
  const t = await getTemario(db, id);
  if (!t) throw new TemarioError("Temario no encontrado.");
  if (t.oculto) throw new TemarioError("Muestra el temario antes de activarlo.");
  const [{ n }] = await db.select({ n: count() }).from(schema.units).where(and(eq(schema.units.temarioId, id), eq(schema.units.activo, true)));
  if (n === 0) throw new TemarioError("Este temario no tiene temas activos: añádelos antes de activarlo.");
  await db
    .insert(schema.settings)
    .values({ key: TEMARIO_ACTIVO_KEY, value: id })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: id } });
}

// ---------- Exportación e importación ----------

export async function exportarTemario(db: DB, id: string) {
  const t = await getTemario(db, id);
  if (!t) return null;
  const units = await db.query.units.findMany({ where: eq(schema.units.temarioId, id), orderBy: asc(schema.units.orden) });
  const qs = units.length
    ? await db.query.questions.findMany({
        where: inArray(
          schema.questions.unitId,
          units.map((u) => u.id),
        ),
        orderBy: [asc(schema.questions.unitId), asc(schema.questions.id)],
      })
    : [];
  return construirPaquete(t as TemarioMeta, units, qs);
}

/** Importa un paquete como temario nuevo. Todo o nada: se valida entero y se escribe en un único lote. */
export async function importarPaquete(db: DB, raw: unknown): Promise<{ ok: true; id: string; temas: number; preguntas: number } | { ok: false; errores: string[] }> {
  const v = validarPaquete(raw);
  if (!v.ok) return v;
  const p = v.paquete;
  if (await getTemario(db, p.temario.id))
    return { ok: false, errores: [`Ya existe un temario con el identificador «${p.temario.id}». Cambia "temario.id" en el paquete para importarlo como otro temario.`] };
  const now = new Date();
  const tid = p.temario.id;
  const unitId = (slug: string) => sql`(SELECT id FROM units WHERE temario_id = ${tid} AND slug = ${slug})`;
  const stmts = [
    db.insert(schema.temarios).values({ ...p.temario, oculto: false, createdAt: now, updatedAt: now }),
    ...p.temas.map((t) => db.insert(schema.units).values({ temarioId: tid, slug: t.slug, orden: t.orden, titulo: t.titulo, contenido: t.contenido, peso: t.peso, activo: t.activo })),
    ...p.preguntas.map((q) =>
      db.insert(schema.questions).values({
        unitId: unitId(String(q.tema)) as unknown as number,
        type: q.tipo,
        dificultad: q.dificultad ?? "media",
        enunciado: q.enunciado,
        options: q.tipo === "written" ? null : q.opciones!,
        correctIndex: q.tipo === "mc" ? q.correcta! : null,
        correctIndexes: q.tipo === "multi" ? [...new Set(q.correctas!)].sort((a, b) => a - b) : null,
        explicacion: q.explicacion ?? null,
        referenceAnswer: q.tipo === "written" ? q.respuesta_referencia! : null,
        keyPoints: q.tipo === "written" ? (q.puntos_clave ?? []) : null,
        activo: q.activo ?? true,
      }),
    ),
  ];
  // db.batch de D1 es una transacción: si falla una sentencia no se guarda ninguna.
  await db.batch(stmts as unknown as [any, ...any[]]);
  return { ok: true, id: tid, temas: p.temas.length, preguntas: p.preguntas.length };
}
