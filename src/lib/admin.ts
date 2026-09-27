import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "./db";
import { schema } from "./db";
import { questionInput, type QuestionInput } from "./questions-io";
import { finalComposition, getSettings } from "./settings";
import { jevAvailable } from "./secrets";
import { questionToInput, resolveUnit } from "./temarios-config";
import { getTemarioActivoId } from "./temarios";

export { resolveUnit };

/** Temas de un temario (las preguntas se resuelven siempre dentro del temario que se está editando). */
const unitsOf = (db: DB, temarioId: string) => db.query.units.findMany({ where: eq(schema.units.temarioId, temarioId) });

function toRow(q: QuestionInput, unitId: number) {
  return {
    unitId,
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
  };
}

export async function createQuestion(db: DB, input: unknown, temarioId: string) {
  const q = questionInput.parse(input);
  const unit = resolveUnit(await unitsOf(db, temarioId), temarioId, q.tema);
  if (!unit) throw new Error(`Tema desconocido: ${q.tema}`);
  const [row] = await db.insert(schema.questions).values(toRow(q, unit.id)).returning({ id: schema.questions.id });
  return row.id;
}

/** Edita una pregunta. Los intentos antiguos no cambian porque guardan una copia. */
export async function updateQuestion(db: DB, id: number, input: unknown, temarioId: string) {
  const q = questionInput.parse(input);
  const unit = resolveUnit(await unitsOf(db, temarioId), temarioId, q.tema);
  if (!unit) throw new Error(`Tema desconocido: ${q.tema}`);
  await db
    .update(schema.questions)
    .set({ ...toRow(q, unit.id), version: sql`${schema.questions.version} + 1` })
    .where(eq(schema.questions.id, id));
}

export async function importQuestions(db: DB, raw: unknown[], temarioId: string) {
  const units = await unitsOf(db, temarioId);
  const errors: { fila: number; error: string }[] = [];
  const rows: ReturnType<typeof toRow>[] = [];
  raw.forEach((r, i) => {
    const parsed = questionInput.safeParse(r);
    if (!parsed.success) {
      errors.push({ fila: i + 1, error: parsed.error.issues.map((x) => x.message).join("; ") });
      return;
    }
    const unit = resolveUnit(units, temarioId, parsed.data.tema);
    if (!unit) {
      errors.push({ fila: i + 1, error: `Tema desconocido: ${parsed.data.tema}` });
      return;
    }
    rows.push(toRow(parsed.data, unit.id));
  });
  // Si hay errores no se importa nada, para no dejar el banco a medias.
  if (errors.length === 0 && rows.length) {
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      await db.batch(chunk.map((r) => db.insert(schema.questions).values(r)) as [any, ...any[]]);
    }
  }
  return { imported: errors.length ? 0 : rows.length, errors };
}

/** Preguntas de un temario en el formato de intercambio (el tema, por su slug dentro del temario). */
export async function exportQuestions(db: DB, temarioId: string): Promise<QuestionInput[]> {
  const units = await unitsOf(db, temarioId);
  const bySlug = new Map(units.map((u) => [u.id, u.slug]));
  if (!units.length) return [];
  const qs = await db.query.questions.findMany({
    where: inArray(
      schema.questions.unitId,
      units.map((u) => u.id),
    ),
    orderBy: [asc(schema.questions.unitId), asc(schema.questions.id)],
  });
  return qs.map((q) => questionToInput(q, bySlug.get(q.unitId)!));
}

/** Preguntas activas por tema y tipo de un temario (por defecto el activo), con aviso si no alcanzan para los tests configurados. */
export async function bankCoverage(db: DB, temarioId?: string) {
  const s = await getSettings(db);
  const comp = finalComposition(s, await jevAvailable(db));
  const tid = temarioId ?? (await getTemarioActivoId(db));
  const units = await db.query.units.findMany({ where: eq(schema.units.temarioId, tid), orderBy: asc(schema.units.orden) });
  const counts = await db
    .select({ unitId: schema.questions.unitId, type: schema.questions.type, dificultad: schema.questions.dificultad, n: count() })
    .from(schema.questions)
    .innerJoin(schema.units, eq(schema.units.id, schema.questions.unitId))
    .where(and(eq(schema.questions.activo, true), eq(schema.units.temarioId, tid)))
    .groupBy(schema.questions.unitId, schema.questions.type, schema.questions.dificultad);
  const get = (u: number, t: string, d?: string) =>
    counts.filter((c) => c.unitId === u && c.type === t && (!d || c.dificultad === d)).reduce((a, c) => a + c.n, 0);
  const active = units.filter((u) => u.activo);
  const rows = units.map((u) => {
    const obj = (d?: string) => get(u.id, "mc", d) + get(u.id, "multi", d);
    const mc = obj();
    const multi = get(u.id, "multi");
    const written = get(u.id, "written");
    const warnings: string[] = [];
    if (u.activo && mc < s.unit_quiz_size) warnings.push(`Menos preguntas tipo test (${mc}) que el tamaño del test (${s.unit_quiz_size})`);
    else if (u.activo && mc < s.unit_quiz_size * 2) warnings.push("Pocas preguntas tipo test para rotar entre intentos");
    if (u.activo && written === 0 && comp.written > 0) warnings.push("Sin preguntas escritas");
    const porDificultad = { baja: obj("baja"), media: obj("media"), alta: obj("alta") };
    if (u.activo && s.mix_alta > 0 && porDificultad.alta === 0) warnings.push("Sin preguntas tipo test de dificultad alta");
    if (u.activo && s.mix_baja > 0 && porDificultad.baja < Math.ceil((s.unit_quiz_size * s.mix_baja) / 100)) warnings.push("Pocas preguntas tipo test de dificultad baja");
    return { unit: u, mc, multi, written, porDificultad, warnings };
  });
  const totalMc = active.reduce((a, u) => a + get(u.id, "mc") + get(u.id, "multi"), 0);
  const totalWritten = active.reduce((a, u) => a + get(u.id, "written"), 0);
  const global: string[] = [];
  if (totalMc < comp.objective) global.push(`Faltan preguntas tipo test para el examen final (${totalMc}/${comp.objective}).`);
  if (totalWritten < comp.written) global.push(`Faltan preguntas escritas para el examen final (${totalWritten}/${comp.written}).`);
  return { rows, global, settings: s, comp, temarioId: tid };
}

export async function stats(db: DB) {
  const [users] = await db.select({ n: count() }).from(schema.users);
  const [carnets] = await db
    .select({ n: count() })
    .from(schema.carnets)
    .where(and(sql`${schema.carnets.revokedAt} IS NULL`, sql`${schema.carnets.expiresAt} > ${Date.now()}`));
  const [finals] = await db.select({ n: count() }).from(schema.attempts).where(eq(schema.attempts.kind, "final"));
  const [grading] = await db.select({ n: count() }).from(schema.attempts).where(eq(schema.attempts.status, "grading"));
  return { users: users.n, carnets: carnets.n, finals: finals.n, grading: grading.n };
}

export async function listUsers(db: DB) {
  const users = await db.query.users.findMany({ orderBy: desc(schema.users.createdAt) });
  // Temas aprobados del temario activo (los de otros temarios no cuentan para el curso actual).
  const temarioId = await getTemarioActivoId(db);
  const passed = await db
    .select({ userId: schema.attempts.userId, n: sql<number>`count(distinct ${schema.attempts.unitId})` })
    .from(schema.attempts)
    .innerJoin(schema.units, eq(schema.units.id, schema.attempts.unitId))
    .where(and(eq(schema.attempts.kind, "unit"), eq(schema.attempts.status, "passed"), eq(schema.units.temarioId, temarioId), eq(schema.units.activo, true)))
    .groupBy(schema.attempts.userId);
  const carnets = await db.query.carnets.findMany({ orderBy: desc(schema.carnets.issuedAt) });
  return users.map((u) => ({
    ...u,
    unitsPassed: passed.find((p) => p.userId === u.id)?.n ?? 0,
    carnet: carnets.find((c) => c.userId === u.id) ?? null,
  }));
}
