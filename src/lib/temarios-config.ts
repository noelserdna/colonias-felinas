// Temarios: identificadores, elección del activo, paquetes de exportación/importación e impacto de un cambio.
// Módulo puro (sin base de datos) para poder probarlo; la parte de base de datos está en `temarios.ts`.
import { z } from "zod";
import { questionInput, type QuestionInput } from "./questions-io";

/** Temario activo cuando no se ha elegido otro (el del manual de Toledo, con el que empezó la aplicación). */
export const TEMARIO_DEFECTO = "toledo-2025";
/** Clave de `settings` con el id del temario activo. */
export const TEMARIO_ACTIVO_KEY = "temario_activo";

export const temarioId = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "El identificador del temario solo admite minúsculas, números y guiones (máx. 40)");

const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const temarioMeta = z.object({
  id: temarioId,
  nombre: z.string().trim().min(1, "Falta el nombre del temario").max(160),
  descripcion: textoOpcional(1000),
  credito: textoOpcional(200),
});
export type TemarioMeta = z.infer<typeof temarioMeta>;

// ---------- Temario activo ----------

export type TemarioResumen = { id: string; oculto: boolean; temasActivos: number };

/**
 * Temario activo: el guardado si existe, no está oculto y tiene temas activos; si no, el de por defecto con temas;
 * si no, el primero que tenga temas activos. Así una instalación sin el manual de Toledo usa el temario propio.
 */
export function elegirTemarioActivo(guardado: unknown, temarios: TemarioResumen[]): string {
  const usable = (id: unknown) => temarios.find((t) => t.id === id && !t.oculto && t.temasActivos > 0);
  return (usable(guardado) ?? usable(TEMARIO_DEFECTO) ?? temarios.find((t) => !t.oculto && t.temasActivos > 0) ?? temarios[0])?.id ?? TEMARIO_DEFECTO;
}

// ---------- Resolución de temas ----------

type UnitLike = { id: number; temarioId: string; slug: string; orden: number };

/**
 * Tema de un temario concreto por su identificador (slug) u orden. Nunca busca fuera del temario: dos temarios
 * pueden repetir slug y orden.
 */
export function resolveUnit<U extends UnitLike>(units: U[], temario: string, tema: string | number): U | undefined {
  const propios = units.filter((u) => u.temarioId === temario);
  return typeof tema === "number" ? propios.find((u) => u.orden === tema) : propios.find((u) => u.slug === tema || String(u.orden) === tema);
}

// ---------- Paquete de exportación / importación ----------

export const PAQUETE_FORMATO = "temario-colonias";
export const PAQUETE_VERSION = 1;

const temaPaquete = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, "El identificador de un tema solo admite minúsculas, números y guiones").max(80),
  orden: z.number().int().min(1).max(999),
  titulo: z.string().trim().min(1).max(200),
  peso: z.number().min(0).max(100).default(1),
  activo: z.boolean().default(true),
  contenido: z.string().min(1, "Un tema no puede estar vacío").max(400_000),
});

export const paqueteTemario = z.object({
  formato: z.literal(PAQUETE_FORMATO, { error: `No es un paquete de temario (falta "formato": "${PAQUETE_FORMATO}")` }),
  version: z.literal(PAQUETE_VERSION, { error: `Versión de paquete no admitida (se espera ${PAQUETE_VERSION})` }),
  temario: temarioMeta,
  temas: z.array(temaPaquete).min(1, "El paquete no tiene temas").max(100),
  // Todo se escribe en un único lote de D1 (límite de consultas por invocación): como máximo 800 preguntas por paquete.
  preguntas: z.array(z.unknown()).max(800, "Como máximo 800 preguntas por paquete: impórtalas aparte desde Preguntas → Importar"),
});
export type PaqueteTemario = Omit<z.infer<typeof paqueteTemario>, "preguntas"> & { preguntas: QuestionInput[] };

/** Valida un paquete completo. Todo o nada: con cualquier error no se importa nada. */
export function validarPaquete(raw: unknown): { ok: true; paquete: PaqueteTemario } | { ok: false; errores: string[] } {
  const base = paqueteTemario.safeParse(raw);
  if (!base.success) {
    return { ok: false, errores: base.error.issues.slice(0, 50).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)) };
  }
  const p = base.data;
  const errores: string[] = [];
  const slugs = new Set<string>();
  const ordenes = new Set<number>();
  for (const t of p.temas) {
    if (slugs.has(t.slug)) errores.push(`Tema repetido: ${t.slug}`);
    if (ordenes.has(t.orden)) errores.push(`Orden repetido en los temas: ${t.orden}`);
    slugs.add(t.slug);
    ordenes.add(t.orden);
  }
  const preguntas: QuestionInput[] = [];
  const temas = p.temas.map((t) => ({ id: 0, temarioId: p.temario.id, slug: t.slug, orden: t.orden }));
  p.preguntas.forEach((raw, i) => {
    const q = questionInput.safeParse(raw);
    if (!q.success) {
      errores.push(`Pregunta ${i + 1}: ${q.error.issues.map((x) => x.message).join("; ")}`);
      return;
    }
    const unit = resolveUnit(temas, p.temario.id, q.data.tema);
    if (!unit) errores.push(`Pregunta ${i + 1}: tema desconocido ${q.data.tema}`);
    else preguntas.push({ ...q.data, tema: unit.slug });
  });
  if (errores.length) return { ok: false, errores: errores.slice(0, 50) };
  return { ok: true, paquete: { ...p, preguntas } };
}

type QuestionRow = {
  unitId: number;
  type: "mc" | "multi" | "written";
  dificultad: "baja" | "media" | "alta";
  enunciado: string;
  options: string[] | null;
  correctIndex: number | null;
  correctIndexes: number[] | null;
  explicacion: string | null;
  referenceAnswer: string | null;
  keyPoints: string[] | null;
  activo: boolean;
};

/** Pregunta de la base de datos en el formato de intercambio (`questions-io.ts`), con el slug de su tema. */
export function questionToInput(q: QuestionRow, tema: string): QuestionInput {
  return {
    tema,
    tipo: q.type,
    dificultad: q.dificultad,
    enunciado: q.enunciado,
    opciones: q.options ?? undefined,
    correcta: q.correctIndex ?? undefined,
    correctas: q.correctIndexes ?? undefined,
    explicacion: q.explicacion,
    respuesta_referencia: q.referenceAnswer,
    puntos_clave: q.keyPoints,
    activo: q.activo,
  };
}

/** Construye el paquete de un temario (metadatos, temas con su Markdown y preguntas). Las imágenes no van dentro. */
export function construirPaquete(
  t: TemarioMeta,
  units: { id: number; slug: string; orden: number; titulo: string; peso: number; activo: boolean; contenido: string }[],
  questions: QuestionRow[],
) {
  const ordenados = [...units].sort((a, b) => a.orden - b.orden);
  const slugDe = new Map(ordenados.map((u) => [u.id, u.slug]));
  return {
    formato: PAQUETE_FORMATO,
    version: PAQUETE_VERSION,
    temario: { id: t.id, nombre: t.nombre, descripcion: t.descripcion ?? null, credito: t.credito ?? null },
    temas: ordenados.map((u) => ({ slug: u.slug, orden: u.orden, titulo: u.titulo, peso: u.peso, activo: u.activo, contenido: u.contenido })),
    preguntas: questions.filter((q) => slugDe.has(q.unitId)).map((q) => questionToInput(q, slugDe.get(q.unitId)!)),
  };
}

// ---------- Impacto de cambiar de temario ----------

export type DatosImpacto = {
  /** Temas activos del temario que se va a activar. */
  temasDestino: number;
  /** Avisos de cobertura del banco de preguntas del temario destino (bankCoverage). */
  avisosCobertura: string[];
  /** Personas sin carnet vigente con algún tema aprobado del temario activo. */
  personasConProgreso: number;
  /** Tests de tema en curso del temario activo. */
  testsEnCurso: number;
  /** Exámenes finales en curso (sin enviar) del temario activo. */
  finalesEnCurso: number;
  /** Exámenes finales enviados que esperan la corrección de JEV. */
  finalesEnCorreccion: number;
  /** Carnets vigentes. */
  carnetsVigentes: number;
};

/** Lo que pasará si se activa el temario destino. `bloqueo` impide la activación (temario sin temas activos). */
export function impactoCambio(d: DatosImpacto): { bloqueo: string | null; avisos: string[] } {
  if (d.temasDestino === 0) return { bloqueo: "Este temario no tiene temas activos: añádelos antes de activarlo.", avisos: [] };
  const n = (x: number, uno: string, varios: string) => `${x} ${x === 1 ? uno : varios}`;
  const avisos: string[] = [];
  if (d.personasConProgreso > 0)
    avisos.push(
      `${n(d.personasConProgreso, "persona sin carnet tiene", "personas sin carnet tienen")} temas aprobados del temario actual: empezarán el nuevo desde el primer tema. Su progreso se conserva y lo recuperan si se vuelve a activar el temario actual.`,
    );
  if (d.testsEnCurso > 0) avisos.push(`${n(d.testsEnCurso, "test de tema en curso quedará", "tests de tema en curso quedarán")} sin efecto para el nuevo temario.`);
  if (d.finalesEnCurso > 0)
    avisos.push(`${n(d.finalesEnCurso, "examen final sin enviar quedará", "exámenes finales sin enviar quedarán")} anulado${d.finalesEnCurso === 1 ? "" : "s"}: habrá que empezar uno nuevo cuando se aprueben los temas del nuevo temario.`);
  if (d.finalesEnCorreccion > 0)
    avisos.push(`${n(d.finalesEnCorreccion, "examen final enviado se está", "exámenes finales enviados se están")} corrigiendo: terminará${d.finalesEnCorreccion === 1 ? "" : "n"} igual y, si se aprueba${d.finalesEnCorreccion === 1 ? "" : "n"}, se emitirá el carnet.`);
  avisos.push(`${n(d.carnetsVigentes, "carnet vigente no cambia", "carnets vigentes no cambian")}: quienes tienen carnet consultarán el nuevo temario.`);
  for (const a of d.avisosCobertura) avisos.push(`Banco de preguntas: ${a}`);
  return { bloqueo: null, avisos };
}
