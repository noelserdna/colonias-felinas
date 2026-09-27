import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import type { DB } from "./db";
import { schema } from "./db";
import { OBJECTIVE_TYPES, type QuestionSnapshot, type QuestionType } from "./db/schema";
import { difficultyMix, finalComposition, getSettings, type Settings } from "./settings";
import { interleave, selectQuestions, type Candidate } from "./selection";
import { computeScore, gradeMc, gradeMulti, isWrittenCorrect } from "./grading";
import { gradeWritten } from "./jev";
import { getActiveCarnet, issueCarnet } from "./carnet";
import { getJevApiKey, jevAvailable } from "./secrets";
import { getBranding } from "./branding";
import { shuffle, uuid } from "./util";
import { activeUnits, getTemarioActivoId } from "./temarios";

export class ExamError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const MAX_WRITTEN_CHARS = 2000;

// ---------- Progreso ----------

export type UnitProgress = {
  id: number;
  slug: string;
  orden: number;
  titulo: string;
  passed: boolean;
  bestPct: number | null;
  unlocked: boolean;
  minutos: number;
};

/** Minutos de lectura aproximados (200 palabras/min), sin contar el HTML de las figuras. */
export function readingMinutes(md: string): number {
  const words = md.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Progreso en el temario activo. El de otros temarios se conserva (va por tema) y vuelve si se reactivan. */
export async function getProgress(db: DB, userId: string) {
  const units = await activeUnits(db);
  const best = await db
    .select({ unitId: schema.attempts.unitId, best: max(schema.attempts.scorePct) })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.userId, userId), eq(schema.attempts.kind, "unit")))
    .groupBy(schema.attempts.unitId);
  const passedRows = await db
    .selectDistinct({ unitId: schema.attempts.unitId })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.userId, userId), eq(schema.attempts.kind, "unit"), eq(schema.attempts.status, "passed")));
  const passedSet = new Set(passedRows.map((r) => r.unitId));
  const bestMap = new Map(best.map((b) => [b.unitId, b.best]));

  let prevPassed = true;
  const list: UnitProgress[] = units.map((u) => {
    const passed = passedSet.has(u.id);
    const p = { id: u.id, slug: u.slug, orden: u.orden, titulo: u.titulo, passed, bestPct: bestMap.get(u.id) ?? null, unlocked: prevPassed, minutos: readingMinutes(u.contenido) };
    prevPassed = prevPassed && passed;
    return p;
  });
  const allPassed = list.length > 0 && list.every((u) => u.passed);
  return { units: list, allPassed };
}

// ---------- Vista pública de un intento (sin respuestas correctas) ----------

type ItemRow = typeof schema.attemptItems.$inferSelect;

export function publicItem(i: ItemRow) {
  const s = i.snapshot;
  return {
    position: i.position,
    type: s.type,
    enunciado: s.enunciado,
    options: s.type !== "written" && i.optionOrder ? i.optionOrder.map((o) => s.options![o]) : undefined,
  };
}

async function loadAttempt(db: DB, attemptId: string, userId?: string) {
  const attempt = await db.query.attempts.findFirst({ where: eq(schema.attempts.id, attemptId) });
  if (!attempt || (userId && attempt.userId !== userId)) throw new ExamError("Intento no encontrado", 404);
  const items = await db.query.attemptItems.findMany({
    where: eq(schema.attemptItems.attemptId, attemptId),
    orderBy: asc(schema.attemptItems.position),
  });
  return { attempt, items };
}

// ---------- Inicio de intentos ----------

async function lastSeenCandidates(db: DB, userId: string, types: readonly QuestionType[], unitIds: number[]): Promise<Candidate[]> {
  if (unitIds.length === 0) return [];
  const qs = await db
    .select({ id: schema.questions.id, unitId: schema.questions.unitId, dificultad: schema.questions.dificultad })
    .from(schema.questions)
    .where(and(inArray(schema.questions.type, [...types]), eq(schema.questions.activo, true), inArray(schema.questions.unitId, unitIds)));
  const seen = await db
    .select({ questionId: schema.attemptItems.questionId, last: max(schema.attempts.startedAt) })
    .from(schema.attemptItems)
    .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptItems.attemptId))
    .where(eq(schema.attempts.userId, userId))
    .groupBy(schema.attemptItems.questionId);
  const seenMap = new Map(seen.map((s) => [s.questionId, s.last ? new Date(s.last as any).getTime() : null]));
  return qs.map((q) => ({ ...q, lastSeen: seenMap.get(q.id) ?? null }));
}

async function createAttempt(
  db: DB,
  userId: string,
  kind: "unit" | "final",
  unitId: number | null,
  passPct: number,
  picked: Candidate[],
  temarioId: string | null = null,
) {
  const full = await db.query.questions.findMany({ where: inArray(schema.questions.id, picked.map((p) => p.id)) });
  const byId = new Map(full.map((q) => [q.id, q]));
  const attemptId = uuid();
  const now = new Date();
  const items = picked.map((p, position) => {
    const q = byId.get(p.id)!;
    const snapshot: QuestionSnapshot = {
      type: q.type,
      enunciado: q.enunciado,
      dificultad: q.dificultad,
      options: q.options ?? undefined,
      correctIndex: q.correctIndex ?? undefined,
      correctIndexes: q.correctIndexes ?? undefined,
      explicacion: q.explicacion,
      referenceAnswer: q.referenceAnswer,
      keyPoints: q.keyPoints,
      unitId: q.unitId,
      version: q.version,
    };
    const optionOrder = q.type !== "written" ? shuffle(q.options!.map((_, i) => i)) : null;
    return { attemptId, position, questionId: q.id, snapshot, optionOrder };
  });
  await db.batch([
    db.insert(schema.attempts).values({
      id: attemptId,
      userId,
      kind,
      unitId,
      status: "in_progress",
      passPct,
      totalCount: items.length,
      startedAt: now,
      temarioId,
    }),
    ...items.map((it) => db.insert(schema.attemptItems).values(it)),
  ]);
  return attemptId;
}

async function findInProgress(db: DB, userId: string, kind: "unit" | "final", unitId: number | null, temarioId?: string) {
  return db.query.attempts.findFirst({
    where: and(
      eq(schema.attempts.userId, userId),
      eq(schema.attempts.kind, kind),
      eq(schema.attempts.status, "in_progress"),
      unitId == null ? isNull(schema.attempts.unitId) : eq(schema.attempts.unitId, unitId),
      // Un final empezado con otro temario queda anulado: no se retoma.
      temarioId ? eq(schema.attempts.temarioId, temarioId) : undefined,
    ),
  });
}

export async function startUnitQuiz(db: DB, userId: string, unitId: number) {
  const { units } = await getProgress(db, userId);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new ExamError("Tema no encontrado", 404);
  if (!unit.unlocked) throw new ExamError("Tienes que aprobar el tema anterior primero", 403);

  const existing = await findInProgress(db, userId, "unit", unitId);
  if (existing) return existing.id;

  const s = await getSettings(db);
  const candidates = await lastSeenCandidates(db, userId, OBJECTIVE_TYPES, [unitId]);
  const { picked } = selectQuestions(s.unit_quiz_size, [{ unitId, weight: 1 }], candidates, 0, Math.random, difficultyMix(s));
  if (picked.length === 0) throw new ExamError("Este tema todavía no tiene preguntas", 409);
  return createAttempt(db, userId, "unit", unitId, s.unit_pass_pct, picked);
}

export async function finalEligibility(db: DB, user: { id: string; nombre: string | null; apellidos: string | null; consentAt: Date | null }) {
  const { allPassed } = await getProgress(db, user.id);
  if (!allPassed) return { ok: false as const, reason: "Aprueba todos los temas para desbloquear el examen final." };
  if (!user.nombre?.trim() || !user.apellidos?.trim() || !user.consentAt)
    return { ok: false as const, reason: "Completa tu perfil (nombre, apellidos y consentimiento) antes del examen final." };
  const carnet = await getActiveCarnet(db, user.id);
  if (carnet) return { ok: false as const, reason: "Ya tienes un carnet vigente." };
  const grading = await db.query.attempts.findFirst({
    where: and(eq(schema.attempts.userId, user.id), eq(schema.attempts.kind, "final"), eq(schema.attempts.status, "grading")),
  });
  if (grading) return { ok: false as const, reason: "Tu último examen se está corrigiendo. Vuelve en unos minutos.", gradingId: grading.id };
  return { ok: true as const };
}

export async function startFinalExam(db: DB, user: Parameters<typeof finalEligibility>[1]) {
  const elig = await finalEligibility(db, user);
  if (!elig.ok) throw new ExamError(elig.reason, 403);
  const temarioId = await getTemarioActivoId(db);
  const existing = await findInProgress(db, user.id, "final", null, temarioId);
  if (existing) return existing.id;

  const s = await getSettings(db);
  const units = await activeUnits(db, temarioId);
  const pools = units.map((u) => ({ unitId: u.id, weight: u.peso }));
  const unitIds = units.map((u) => u.id);
  const mix = difficultyMix(s);
  // Sin clave de JEV no se ofrecen preguntas escritas: se sustituyen por objetivas.
  const comp = finalComposition(s, await jevAvailable(db));
  const mc = selectQuestions(comp.objective, pools, await lastSeenCandidates(db, user.id, OBJECTIVE_TYPES, unitIds), s.final_min_per_unit, Math.random, mix);
  const wr = selectQuestions(comp.written, pools, await lastSeenCandidates(db, user.id, ["written"], unitIds), s.final_min_per_unit, Math.random, mix);
  if (mc.shortfall + wr.shortfall > 0) {
    throw new ExamError("El banco de preguntas no tiene suficientes preguntas activas. Avisa al ayuntamiento.", 409);
  }
  // Las escritas se reparten a lo largo del examen en lugar de ir todas al final.
  return createAttempt(db, user.id, "final", null, s.final_pass_pct, interleave(mc.picked, wr.picked), temarioId);
}

export async function getAttemptForUser(db: DB, attemptId: string, userId: string) {
  const { attempt, items } = await loadAttempt(db, attemptId, userId);
  return { attempt, items };
}

// ---------- Envío y corrección ----------

export type Answers = Record<string, number | number[] | string | null>;

export async function submitAttempt(db: DB, attemptId: string, userId: string, answers: Answers) {
  const { attempt, items } = await loadAttempt(db, attemptId, userId);
  if (attempt.status !== "in_progress") throw new ExamError("Este intento ya se envió", 409);
  if (attempt.kind === "final" && attempt.temarioId && attempt.temarioId !== (await getTemarioActivoId(db)))
    throw new ExamError("El Ayuntamiento ha cambiado el temario del curso y este examen ya no es válido.", 409);

  // Marca el intento como enviado de forma atómica para impedir envíos dobles.
  const claimed = await db
    .update(schema.attempts)
    .set({ status: "grading", submittedAt: new Date() })
    .where(and(eq(schema.attempts.id, attemptId), eq(schema.attempts.status, "in_progress")))
    .returning({ id: schema.attempts.id });
  if (claimed.length === 0) throw new ExamError("Este intento ya se envió", 409);

  const updates = items.map((it) => {
    const raw = answers[String(it.position)];
    if (it.snapshot.type === "mc") {
      const r = gradeMc(typeof raw === "number" ? raw : raw == null ? null : Number(raw), it.optionOrder ?? [], it.snapshot.correctIndex!);
      return db
        .update(schema.attemptItems)
        .set({ answer: r.original == null ? null : String(r.original), isCorrect: r.correct })
        .where(eq(schema.attemptItems.id, it.id));
    }
    if (it.snapshot.type === "multi") {
      const r = gradeMulti(raw, it.optionOrder ?? [], it.snapshot.correctIndexes ?? []);
      return db
        .update(schema.attemptItems)
        .set({ answer: JSON.stringify(r.original), isCorrect: r.correct })
        .where(eq(schema.attemptItems.id, it.id));
    }
    const text = typeof raw === "string" ? raw.trim().slice(0, MAX_WRITTEN_CHARS) : "";
    // Las escritas vacías se dan por incorrectas sin llamar a JEV.
    return db
      .update(schema.attemptItems)
      .set({ answer: text, isCorrect: text ? null : false })
      .where(eq(schema.attemptItems.id, it.id));
  });
  await db.batch(updates as [any, ...any[]]);
  return gradePending(db, attemptId);
}

/** Corrige con JEV las escritas pendientes y, si no queda ninguna, cierra el intento. Idempotente. */
export async function gradePending(db: DB, attemptId: string) {
  const { attempt, items } = await loadAttempt(db, attemptId);
  if (attempt.status !== "grading") return attempt;
  const s = await getSettings(db);
  const pending = items.filter((i) => i.snapshot.type === "written" && i.isCorrect == null);

  if (pending.length > 0) {
    const [{ key: apiKey }, branding] = await Promise.all([getJevApiKey(db), getBranding(db)]);
    const results = await Promise.allSettled(
      pending.map((it) =>
        gradeWritten(
          {
            pregunta: it.snapshot.enunciado,
            respuesta_referencia: it.snapshot.referenceAnswer ?? "",
            puntos_clave: it.snapshot.keyPoints ?? [],
            respuesta_alumno: it.answer ?? "",
          },
          { apiKey: apiKey ?? undefined, ayuntamiento: branding.ayuntamiento, mock: env.JEV_MOCK === "1" },
        ),
      ),
    );
    const ups = results.flatMap((r, idx) => {
      if (r.status === "rejected") {
        console.error("JEV error", attemptId, r.reason);
        return [];
      }
      const v = r.value;
      return [
        db
          .update(schema.attemptItems)
          .set({
            isCorrect: isWrittenCorrect(v, s.jev_pass_score, s.jev_flag_threshold),
            jevScore: v.score,
            jevConfidence: v.confidence,
            jevFlag: v.flag,
            jevRaw: v.raw,
          })
          .where(eq(schema.attemptItems.id, pending[idx].id)),
      ];
    });
    if (ups.length) await db.batch(ups as [any, ...any[]]);
    if (ups.length < pending.length) {
      await db
        .update(schema.attempts)
        .set({ gradingTries: sql`${schema.attempts.gradingTries} + 1` })
        .where(eq(schema.attempts.id, attemptId));
      return { ...attempt, status: "grading" as const };
    }
  }
  return finalize(db, attemptId, s);
}

async function finalize(db: DB, attemptId: string, s: Settings) {
  const { attempt, items } = await loadAttempt(db, attemptId);
  const score = computeScore(items, attempt.passPct);
  const status = score.passed ? "passed" : "failed";
  const done = await db
    .update(schema.attempts)
    .set({ status, scorePct: score.pct, correctCount: score.correct })
    .where(and(eq(schema.attempts.id, attemptId), eq(schema.attempts.status, "grading")))
    .returning();
  if (done.length && attempt.kind === "final" && score.passed) {
    await issueCarnet(db, attempt.userId, attemptId, s, attempt.temarioId);
  }
  return done[0] ?? (await loadAttempt(db, attemptId)).attempt;
}

/** Cron: reintenta la corrección de exámenes que quedaron en "grading". */
export async function retryPendingGrading(db: DB) {
  const stuck = await db.query.attempts.findMany({ where: eq(schema.attempts.status, "grading"), limit: 20 });
  for (const a of stuck) {
    try {
      await gradePending(db, a.id);
    } catch (e) {
      console.error("retryPendingGrading", a.id, e);
    }
  }
  return stuck.length;
}

// ---------- Resultados ----------

export function reviewItems(items: ItemRow[], revealAnswers: boolean) {
  return items.map((i) => {
    const s = i.snapshot;
    const base = { position: i.position, type: s.type, enunciado: s.enunciado, isCorrect: i.isCorrect, unitId: s.unitId };
    if (!revealAnswers) return base;
    return {
      ...base,
      options: s.options,
      chosen: i.answer == null ? null : s.type === "mc" ? Number(i.answer) : s.type === "multi" ? (JSON.parse(i.answer) as number[]) : i.answer,
      correctIndex: s.correctIndex,
      correctIndexes: s.correctIndexes,
      explicacion: s.explicacion,
      referenceAnswer: s.referenceAnswer,
    };
  });
}
