import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  nombre: text("nombre"),
  apellidos: text("apellidos"),
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  consentAt: integer("consent_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const magicTokens = sqliteTable("magic_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
});

export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Temarios (conjuntos de temas con sus preguntas). Solo uno está activo a la vez (clave `temario_activo` de
 * `settings`); los demás se conservan con su progreso para poder volver a ellos.
 */
export const temarios = sqliteTable("temarios", {
  id: text("id").primaryKey(),
  nombre: text("nombre").notNull(),
  descripcion: text("descripcion"),
  // Autoría y licencia: se cita en el pie en lugar de branding.credito_formativo cuando está rellena.
  credito: text("credito"),
  // Oculto: no se ofrece para activar ni aparece por defecto en los selectores del panel.
  oculto: integer("oculto", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const units = sqliteTable(
  "units",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Temario al que pertenece. Sin REFERENCES para poder añadir la columna con ALTER TABLE (sin reconstruir la
    // tabla, que tiene claves ajenas entrantes); la integridad la garantiza la aplicación.
    temarioId: text("temario_id").notNull().default("toledo-2025"),
    slug: text("slug").notNull(),
    orden: integer("orden").notNull(),
    titulo: text("titulo").notNull(),
    contenido: text("contenido").notNull(),
    // Peso relativo del tema en el reparto de preguntas del examen final.
    peso: real("peso").notNull().default(1),
    activo: integer("activo", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("units_temario_slug_unique").on(t.temarioId, t.slug)],
);

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    unitId: integer("unit_id").notNull().references(() => units.id),
    // mc = una correcta · multi = una o varias correctas (casillas) · written = respuesta escrita (JEV)
    type: text("type", { enum: ["mc", "multi", "written"] }).notNull(),
    enunciado: text("enunciado").notNull(),
    dificultad: text("dificultad", { enum: ["baja", "media", "alta"] }).notNull().default("media"),
    // Solo tipo test: lista de opciones e índice de la correcta.
    options: text("options", { mode: "json" }).$type<string[]>(),
    correctIndex: integer("correct_index"),
    // Solo "multi": índices de todas las opciones correctas.
    correctIndexes: text("correct_indexes", { mode: "json" }).$type<number[]>(),
    explicacion: text("explicacion"),
    // Solo escritas: respuesta modelo y puntos clave para JEV.
    referenceAnswer: text("reference_answer"),
    keyPoints: text("key_points", { mode: "json" }).$type<string[]>(),
    activo: integer("activo", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (t) => [index("questions_unit_type").on(t.unitId, t.type, t.activo)],
);

export const DIFICULTADES = ["baja", "media", "alta"] as const;
export type Dificultad = (typeof DIFICULTADES)[number];
export const DIFICULTAD_LABEL: Record<Dificultad, string> = { baja: "Baja", media: "Media", alta: "Alta" };

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["unit", "final"] }).notNull(),
    unitId: integer("unit_id").references(() => units.id),
    status: text("status", { enum: ["in_progress", "grading", "passed", "failed"] }).notNull(),
    // Porcentaje de aprobado vigente cuando empezó el intento.
    passPct: real("pass_pct").notNull(),
    scorePct: real("score_pct"),
    correctCount: integer("correct_count"),
    totalCount: integer("total_count").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    gradingTries: integer("grading_tries").notNull().default(0),
    // Temario con el que se hizo el examen final (null en los tests de tema: su tema ya lo indica).
    temarioId: text("temario_id"),
  },
  (t) => [index("attempts_user").on(t.userId, t.kind, t.status)],
);

export type QuestionType = "mc" | "multi" | "written";
/** Tipos que se corrigen automáticamente por opciones (cuentan como «tipo test» en el examen). */
export const OBJECTIVE_TYPES = ["mc", "multi"] as const;

export type QuestionSnapshot = {
  type: QuestionType;
  enunciado: string;
  dificultad?: Dificultad;
  options?: string[];
  correctIndex?: number;
  correctIndexes?: number[];
  explicacion?: string | null;
  referenceAnswer?: string | null;
  keyPoints?: string[] | null;
  unitId: number;
  version: number;
};

export const attemptItems = sqliteTable(
  "attempt_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    attemptId: text("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    questionId: integer("question_id").notNull().references(() => questions.id),
    snapshot: text("snapshot", { mode: "json" }).$type<QuestionSnapshot>().notNull(),
    // Orden de opciones mostrado: optionOrder[i] = índice original de la opción mostrada en i.
    optionOrder: text("option_order", { mode: "json" }).$type<number[]>(),
    answer: text("answer"),
    isCorrect: integer("is_correct", { mode: "boolean" }),
    jevScore: real("jev_score"),
    jevConfidence: real("jev_confidence"),
    jevFlag: real("jev_flag"),
    jevRaw: text("jev_raw", { mode: "json" }),
  },
  (t) => [uniqueIndex("attempt_items_pos").on(t.attemptId, t.position), index("attempt_items_q").on(t.questionId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

export const carnets = sqliteTable("carnets", {
  id: text("id").primaryKey(),
  numero: text("numero").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  nombre: text("nombre").notNull(),
  apellidos: text("apellidos").notNull(),
  issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  attemptId: text("attempt_id").references(() => attempts.id),
  // Temario con el que se acreditó la persona.
  temarioId: text("temario_id"),
});

export const counters = sqliteTable("counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
});

/** Ficheros pequeños configurables desde el panel (p. ej. el escudo), guardados en base64. */
export const assets = sqliteTable("assets", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull(),
  dataB64: text("data_b64").notNull(),
  version: text("version").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Comunicaciones de accesibilidad (RD 1112/2018, art. 10.2.b): quejas, solicitudes de información accesible y sugerencias. */
export const accessibilityReports = sqliteTable("accessibility_reports", {
  id: text("id").primaryKey(),
  tipo: text("tipo", { enum: ["queja", "solicitud", "sugerencia"] }).notNull(),
  pagina: text("pagina"),
  descripcion: text("descripcion").notNull(),
  nombre: text("nombre"),
  email: text("email"),
  estado: text("estado", { enum: ["nueva", "en_tramite", "resuelta"] }).notNull().default("nueva"),
  respuesta: text("respuesta"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

/** Documentos del ayuntamiento (enlaces externos: portal de transparencia, sede electrónica, BOE…). */
export const DOC_CATEGORIAS = {
  ordenanza: "Ordenanzas",
  formulario: "Formularios y solicitudes",
  normativa: "Normativa",
  guia: "Guías e información",
  otro: "Otros documentos",
} as const;
export type DocCategoria = keyof typeof DOC_CATEGORIAS;

export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  titulo: text("titulo").notNull(),
  categoria: text("categoria", { enum: ["ordenanza", "formulario", "normativa", "guia", "otro"] }).notNull(),
  descripcion: text("descripcion"),
  url: text("url").notNull(),
  // Fecha del documento (aprobación, publicación…), opcional.
  fecha: text("fecha"),
  orden: integer("orden").notNull().default(0),
  activo: integer("activo", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------- Colonias felinas (registro, cuidadores, censo y fichas de los gatos) ----------

export const colonies = sqliteTable("colonies", {
  id: text("id").primaryKey(),
  numero: integer("numero").notNull().unique(),
  nombre: text("nombre").notNull(),
  direccion: text("direccion").notNull(),
  coordenadas: text("coordenadas"),
  titularidad: text("titularidad", { enum: ["publico", "privado"] }).notNull(),
  estado: text("estado", { enum: ["activa", "sin_cuidadores", "baja"] }).notNull().default("activa"),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Personas que cuidan cada colonia. `until` marca el fin de la colaboración. */
export const colonyMembers = sqliteTable(
  "colony_members",
  {
    id: text("id").primaryKey(),
    colonyId: text("colony_id").notNull().references(() => colonies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    rol: text("rol", { enum: ["responsable", "colaborador"] }).notNull(),
    since: integer("since", { mode: "timestamp_ms" }).notNull(),
    until: integer("until", { mode: "timestamp_ms" }),
    bajaMotivo: text("baja_motivo"),
    bajaJev: text("baja_jev", { mode: "json" }),
    bajaPor: text("baja_por", { enum: ["cuidador", "ayuntamiento"] }),
  },
  (t) => [index("colony_members_user").on(t.userId), index("colony_members_colony").on(t.colonyId)],
);

/**
 * Censo de la colonia (se actualiza cada `censo_meses` a través de las personas cuidadoras). Los movimientos
 * desde el censo anterior, por sexo, son opcionales (null = no declarados); ver `censo_movimientos`.
 */
export const colonyCensuses = sqliteTable(
  "colony_censuses",
  {
    id: text("id").primaryKey(),
    colonyId: text("colony_id").notNull().references(() => colonies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    fecha: integer("fecha", { mode: "timestamp_ms" }).notNull(),
    hembrasEsterilizadas: integer("hembras_esterilizadas").notNull().default(0),
    hembrasSinEsterilizar: integer("hembras_sin_esterilizar").notNull().default(0),
    machosCastrados: integer("machos_castrados").notNull().default(0),
    machosSinCastrar: integer("machos_sin_castrar").notNull().default(0),
    adoptables: integer("adoptables").notNull().default(0),
    enfermos: integer("enfermos").notNull().default(0),
    observaciones: text("observaciones"),
    nacidosHembras: integer("nacidos_hembras"),
    nacidosMachos: integer("nacidos_machos"),
    nuevosHembras: integer("nuevos_hembras"),
    nuevosMachos: integer("nuevos_machos"),
    fallecidosHembras: integer("fallecidos_hembras"),
    fallecidosMachos: integer("fallecidos_machos"),
    adoptadosHembras: integer("adoptados_hembras"),
    adoptadosMachos: integer("adoptados_machos"),
    devueltosHembras: integer("devueltos_hembras"),
    devueltosMachos: integer("devueltos_machos"),
    otrasSalidasHembras: integer("otras_salidas_hembras"),
    otrasSalidasMachos: integer("otras_salidas_machos"),
  },
  (t) => [index("colony_censuses_colony").on(t.colonyId, t.fecha)],
);

/** Ficha identificativa de cada gato (en San Román, el Anexo IV de la ordenanza). */
export const colonyCats = sqliteTable(
  "colony_cats",
  {
    id: text("id").primaryKey(),
    colonyId: text("colony_id").notNull().references(() => colonies.id, { onDelete: "cascade" }),
    nombre: text("nombre").notNull(),
    sexo: text("sexo", { enum: ["hembra", "macho", "desconocido"] }).notNull(),
    edad: text("edad"),
    descripcion: text("descripcion"),
    esterilizado: integer("esterilizado", { mode: "boolean" }).notNull().default(false),
    marcaOreja: integer("marca_oreja", { mode: "boolean" }).notNull().default(false),
    microchip: text("microchip"),
    estado: text("estado", { enum: ["en_colonia", "adoptado", "fallecido", "desaparecido", "trasladado", "devuelto"] }).notNull().default("en_colonia"),
    // Desde cuándo está en su situación actual (para rellenar los movimientos del censo desde las fichas).
    estadoDesde: integer("estado_desde", { mode: "timestamp_ms" }),
    observaciones: text("observaciones"),
    // Foto principal de la ficha (tabla photos).
    photoId: text("photo_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("colony_cats_colony").on(t.colonyId)],
);

/** Intervenciones de cada gato (captura, motivo, clínica, vacunas…). */
export const catInterventions = sqliteTable(
  "cat_interventions",
  {
    id: text("id").primaryKey(),
    catId: text("cat_id").notNull().references(() => colonyCats.id, { onDelete: "cascade" }),
    fecha: text("fecha").notNull(), // AAAA-MM-DD
    motivo: text("motivo", { enum: ["esterilizacion", "enfermedad", "vacunacion", "desparasitacion", "revision", "otro"] }).notNull(),
    clinica: text("clinica"),
    notas: text("notas"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("cat_interventions_cat").on(t.catId)],
);

/** Observaciones de seguimiento de cada gato (texto libre con fotos asociadas). */
export const catNotes = sqliteTable(
  "cat_notes",
  {
    id: text("id").primaryKey(),
    catId: text("cat_id").notNull().references(() => colonyCats.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    texto: text("texto").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("cat_notes_cat").on(t.catId, t.createdAt)],
);

/** Fotos privadas de las colonias (reducidas en el móvil antes de subirlas). */
export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(),
    colonyId: text("colony_id").notNull().references(() => colonies.id, { onDelete: "cascade" }),
    catId: text("cat_id").references(() => colonyCats.id, { onDelete: "cascade" }),
    noteId: text("note_id").references(() => catNotes.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull(),
    // Clave del fichero en R2 (bucket PHOTOS).
    storageKey: text("storage_key"),
    // Solo para fotos antiguas guardadas en D1 antes de pasar a R2 (se vacía al migrarlas).
    dataB64: text("data_b64"),
    bytes: integer("bytes").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("photos_cat").on(t.catId), index("photos_note").on(t.noteId)],
);

/** Avisos a una persona dentro de la aplicación (alta de colonia, cambios de rol…). También se envían por correo. */
export const notices = sqliteTable(
  "notices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tipo: text("tipo", { enum: ["colonia_alta", "colonia_miembro", "colonia_responsable", "colonia_baja", "colonia_censo", "carnet_caduca", "prueba"] }).notNull(),
    titulo: text("titulo").notNull(),
    texto: text("texto").notNull(),
    url: text("url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("notices_user").on(t.userId, t.readAt)],
);

/** Bandeja de la instancia demo: en ella los correos no se envían, se guardan aquí para enseñarlos. */
export const demoOutbox = sqliteTable(
  "demo_outbox",
  {
    id: text("id").primaryKey(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("demo_outbox_to").on(t.to, t.createdAt)],
);

/** Suscripciones a notificaciones push (una por navegador o móvil en el que la persona las activa). */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("push_subscriptions_user").on(t.userId)],
);
