// Datos de la instancia demo: copias de los perfiles para cada visitante, datos de base para el panel del
// Ayuntamiento y reinicio nocturno. Solo se usa con DEMO=1.
import { and, eq, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import type { DB } from "./db";
import * as schema from "./db/schema";
import { censusPeriodStart, createColony } from "./colonies";
import { getPrograma } from "./programa";
import type { Programa } from "./programa-config";
import { issueCarnet, caducidad } from "./carnet";
import { getSettings } from "./settings";
import { getAttemptForUser, startFinalExam, submitAttempt } from "./exam";
import { notifyColony } from "./notices";
import { activeUnits } from "./temarios";
import { exampleAnswers, PERSONA_DOMAIN, PERSONAS, personaEmail, randomName, type CursoDemo, type PersonaKey } from "./demo-personas";

const uuid = () => crypto.randomUUID();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Días desde el censo de una colonia con el censo pendiente, según la periodicidad del programa local. */
const censoPendiente = (p: Programa) => p.censo_meses * 31 + 10;
/** Días desde el censo de una colonia al día (dentro del periodo en curso si el censo va por periodos naturales). */
function censoAlDia(p: Programa) {
  const max = Math.max(0, Math.floor((p.censo_meses * 30) / 2));
  if (!p.censo_alineado) return Math.min(35, max);
  return Math.min(35, max, Math.floor((Date.now() - censusPeriodStart(new Date(), p.censo_meses).getTime()) / DAY));
}

/** Ilustraciones de gatos subidas a R2 con `scripts/upload-demo-gatos.mjs`. */
export const GATOS_BASE = ["misi", "tizon", "nube", "tigre", "canela", "sombra"] as const;
const baseKey = (g: string) => `demo-base/gatos/${g}.jpg`;

type Ctx = { origin: string; ayuntamiento: string };

// ---------- Piezas ----------

async function createUser(db: DB, u: { email: string; nombre: string; apellidos: string; role?: "user" | "admin"; createdAt?: Date }) {
  const id = uuid();
  await db.insert(schema.users).values({
    id,
    email: u.email,
    nombre: u.nombre,
    apellidos: u.apellidos,
    role: u.role ?? "user",
    consentAt: u.createdAt ?? new Date(),
    createdAt: u.createdAt ?? new Date(),
  });
  return id;
}

/** Temas aprobados: intentos «passed» con fechas escalonadas (sin detalle de preguntas). */
async function passUnits(db: DB, userId: string, count: number | "todos", startDaysAgo = 40) {
  const units = await activeUnits(db);
  const n = count === "todos" ? units.length : Math.min(count, units.length);
  if (n === 0) return;
  const rows = units.slice(0, n).map((u, i) => {
    const when = ago(Math.max(startDaysAgo - i * 3, 1));
    const correct = 7 + ((i * 5 + userId.charCodeAt(0)) % 4); // 7–10 de 10
    return db.insert(schema.attempts).values({
      id: uuid(),
      userId,
      kind: "unit",
      unitId: u.id,
      status: "passed",
      passPct: 70,
      scorePct: correct * 10,
      correctCount: correct,
      totalCount: 10,
      startedAt: new Date(when.getTime() - 8 * 60_000),
      submittedAt: when,
    });
  });
  await db.batch(rows as [any, ...any[]]);
}

/** Número de temas del temario activo y de preguntas del examen final, para los textos de los perfiles. */
export async function cursoDemo(db: DB): Promise<CursoDemo> {
  const [units, s] = await Promise.all([activeUnits(db), getSettings(db)]);
  return { temas: units.length, preguntas: s.final_mc_count + s.final_written_count };
}

/** Aprueba un tema concreto (atajo de la demo). */
export async function demoPassUnit(db: DB, userId: string, unitId: number) {
  const now = new Date();
  await db.insert(schema.attempts).values({
    id: uuid(),
    userId,
    kind: "unit",
    unitId,
    status: "passed",
    passPct: 70,
    scorePct: 90,
    correctCount: 9,
    totalCount: 10,
    startedAt: new Date(now.getTime() - 5 * 60_000),
    submittedAt: now,
  });
}

async function carnetFor(db: DB, userId: string, issued?: Date) {
  const s = await getSettings(db);
  const c = await issueCarnet(db, userId, null, s);
  if (issued) {
    await db.update(schema.carnets).set({ issuedAt: issued, expiresAt: caducidad(issued, s.carnet_validity_months) }).where(eq(schema.carnets.id, c.id));
  }
  return c;
}

/** Copia una ilustración de gato de la base a la carpeta de la colonia y la registra como foto. */
async function catPhoto(db: DB, colonyId: string, catId: string, gato: string, userId: string, noteId: string | null = null) {
  const src = await env.PHOTOS.get(baseKey(gato));
  if (!src) return null; // sin ilustraciones subidas, la ficha queda sin foto
  const bytes = new Uint8Array(await src.arrayBuffer());
  const id = uuid();
  const storageKey = `colonias/${colonyId}/${id}.jpg`;
  await env.PHOTOS.put(storageKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await db.insert(schema.photos).values({ id, colonyId, catId, noteId, contentType: "image/jpeg", storageKey, bytes: bytes.length, userId, createdAt: new Date() });
  return id;
}

type GatoDemo = {
  nombre: string;
  sexo: "hembra" | "macho" | "desconocido";
  edad: string;
  descripcion: string;
  esterilizado: boolean;
  estado?: "en_colonia" | "adoptado" | "devuelto";
  foto?: (typeof GATOS_BASE)[number];
  intervenciones?: { dias: number; motivo: "esterilizacion" | "vacunacion" | "desparasitacion" | "revision" | "enfermedad"; notas?: string }[];
  nota?: { dias: number; texto: string; foto?: (typeof GATOS_BASE)[number] };
};

const GATOS_POLIDEPORTIVO: GatoDemo[] = [
  {
    nombre: "Misi",
    sexo: "hembra",
    edad: "Unos 3 años",
    descripcion: "Atigrada naranja, muy confiada. Siempre la primera en llegar al comedero.",
    esterilizado: true,
    foto: "misi",
    intervenciones: [
      { dias: 120, motivo: "esterilizacion", notas: "Método CER. Oreja izquierda marcada." },
      { dias: 60, motivo: "desparasitacion" },
    ],
    nota: { dias: 6, texto: "Hoy ha comido bien y tiene el pelo brillante. Sin novedades.", foto: "misi" },
  },
  {
    nombre: "Tizón",
    sexo: "macho",
    edad: "Adulto",
    descripcion: "Negro, grande, algo desconfiado. Viene al atardecer.",
    esterilizado: true,
    foto: "tizon",
    intervenciones: [{ dias: 95, motivo: "esterilizacion", notas: "Castrado. Oreja marcada." }],
  },
  {
    nombre: "Nube",
    sexo: "hembra",
    edad: "Menos de 1 año",
    descripcion: "Blanca, ojos azules. Llegó en primavera.",
    esterilizado: false,
    foto: "nube",
    nota: { dias: 3, texto: "Parece que está en celo: conviene pedir cita para la esterilización." },
  },
  {
    nombre: "Tigre",
    sexo: "macho",
    edad: "Unos 5 años",
    descripcion: "Atigrado pardo, con una cicatriz en la nariz.",
    esterilizado: true,
    foto: "tigre",
    intervenciones: [
      { dias: 200, motivo: "esterilizacion" },
      { dias: 20, motivo: "revision", notas: "Revisión por una herida en la pata: curada." },
    ],
  },
  {
    nombre: "Canela",
    sexo: "hembra",
    edad: "Cachorra",
    descripcion: "Blanca con manchas canela. Muy sociable, candidata a adopción.",
    esterilizado: false,
    estado: "adoptado",
    foto: "canela",
  },
  {
    nombre: "Sombra",
    sexo: "macho",
    edad: "Unos 2 años",
    descripcion: "Gris, muy tranquilo. Tenía microchip: se devolvió a la familia que lo había perdido.",
    esterilizado: true,
    estado: "devuelto",
    foto: "sombra",
  },
];

async function addCats(db: DB, colonyId: string, userId: string, gatos: GatoDemo[]) {
  for (const g of gatos) {
    const id = uuid();
    const created = ago(150);
    await db.insert(schema.colonyCats).values({
      id,
      colonyId,
      nombre: g.nombre,
      sexo: g.sexo,
      edad: g.edad,
      descripcion: g.descripcion,
      esterilizado: g.esterilizado,
      marcaOreja: g.esterilizado,
      estado: g.estado ?? "en_colonia",
      // Los que ya no están en la colonia salieron hace un mes.
      estadoDesde: g.estado && g.estado !== "en_colonia" ? ago(30) : created,
      createdAt: created,
      updatedAt: created,
    });
    if (g.foto) {
      const photoId = await catPhoto(db, colonyId, id, g.foto, userId);
      if (photoId) await db.update(schema.colonyCats).set({ photoId }).where(eq(schema.colonyCats.id, id));
    }
    for (const iv of g.intervenciones ?? []) {
      await db.insert(schema.catInterventions).values({
        id: uuid(),
        catId: id,
        fecha: isoDay(ago(iv.dias)),
        motivo: iv.motivo,
        clinica: "Clínica Veterinaria del Valle (demo)",
        notas: iv.notas ?? null,
        userId,
        createdAt: ago(iv.dias),
      });
    }
    if (g.nota) {
      const noteId = uuid();
      await db.insert(schema.catNotes).values({ id: noteId, catId: id, userId, texto: g.nota.texto, createdAt: ago(g.nota.dias) });
      if (g.nota.foto) await catPhoto(db, colonyId, id, g.nota.foto, userId, noteId);
    }
  }
}

/** Colonia con su responsable (y colaboradores), censo con fecha y fichas de gatos. */
async function colonyWith(
  db: DB,
  opts: { nombre: string; direccion: string; coordenadas?: string; titularidad?: "publico" | "privado"; responsableId: string; colaboradores?: string[]; censoDias: number; censo: [number, number, number, number]; gatos?: GatoDemo[] },
) {
  const [he, hs, mc, ms] = opts.censo;
  const { id } = await createColony(db, {
    colony: { nombre: opts.nombre, direccion: opts.direccion, coordenadas: opts.coordenadas, titularidad: opts.titularidad ?? "publico" },
    responsableId: opts.responsableId,
    colaboradores: opts.colaboradores ?? [],
    census: { hembrasEsterilizadas: he, hembrasSinEsterilizar: hs, machosCastrados: mc, machosSinCastrar: ms, adoptables: 1, enfermos: 0 },
  });
  const since = ago(opts.censoDias + 10);
  await db.batch([
    db.update(schema.colonies).set({ createdAt: since, updatedAt: since }).where(eq(schema.colonies.id, id)),
    db.update(schema.colonyMembers).set({ since }).where(eq(schema.colonyMembers.colonyId, id)),
    db.update(schema.colonyCensuses).set({ fecha: ago(opts.censoDias) }).where(eq(schema.colonyCensuses.colonyId, id)),
  ]);
  if (opts.gatos) await addCats(db, id, opts.responsableId, opts.gatos);
  return id;
}

// ---------- Perfiles para cada visitante ----------

/** Crea una copia nueva del perfil elegido, con todo su estado. Devuelve el id de usuario. */
export async function createPersona(db: DB, key: PersonaKey, ctx: Ctx): Promise<string> {
  const p = PERSONAS[key];
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const { nombre, apellidos } = key === "ayuntamiento" ? { nombre: "Técnico/a", apellidos: "de Bienestar Animal" } : randomName(parseInt(rand, 36));
  const userId = await createUser(db, { email: personaEmail(key, rand), nombre, apellidos, role: p.admin ? "admin" : "user", createdAt: ago(45) });
  await passUnits(db, userId, p.aprobados);
  if (p.carnet) await carnetFor(db, userId, ago(20));
  if (p.colonia) {
    const programa = await getPrograma(db);
    // Una compañera colaboradora, también acreditada, para que la colonia tenga equipo.
    const comp = randomName(parseInt(rand, 36) + 3);
    const compId = await createUser(db, { email: personaEmail("carnet", `${rand}c`), ...comp, createdAt: ago(60) });
    await passUnits(db, compId, "todos", 55);
    await carnetFor(db, compId, ago(30));
    const colonyId = await colonyWith(db, {
      nombre: "Parque de la Constitución",
      direccion: "Parque de la Constitución, junto a la fuente",
      coordenadas: "40.0723, -4.4051",
      responsableId: userId,
      colaboradores: [compId],
      censoDias: censoPendiente(programa), // «toca actualizarlo»
      censo: [4, 1, 2, 1],
      gatos: GATOS_POLIDEPORTIVO,
    });
    // El aviso de alta (también «llega» a la bandeja de correos de la demo).
    await notifyColony(db, ctx, colonyId, [userId], "colonia_alta");
  }
  return userId;
}

// ---------- Reinicio y datos de base ----------

/** Borra todo lo que crean los visitantes y deja los datos de base. Los contenidos (temario, preguntas…) no se tocan. */
export async function resetDemo(db: DB, ctx: Ctx) {
  // Fotos de R2 de las colonias (las ilustraciones de base, en demo-base/, se conservan).
  let cursor: string | undefined;
  do {
    const list = await env.PHOTOS.list({ prefix: "colonias/", cursor });
    if (list.objects.length) await env.PHOTOS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  await db.batch([
    db.delete(schema.photos),
    db.delete(schema.catNotes),
    db.delete(schema.catInterventions),
    db.delete(schema.colonyCats),
    db.delete(schema.colonyCensuses),
    db.delete(schema.colonyMembers),
    db.delete(schema.colonies),
    db.delete(schema.notices),
    db.delete(schema.carnets),
    db.delete(schema.attemptItems),
    db.delete(schema.attempts),
    db.delete(schema.sessions),
    db.delete(schema.magicTokens),
    db.delete(schema.accessibilityReports),
    db.delete(schema.demoOutbox),
    db.delete(schema.users),
    db.run(sql`DELETE FROM counters WHERE key = 'colonia' OR key LIKE 'carnet-%'`),
  ] as [any, ...any[]]);

  await seedBase(db, ctx);
}

const base = (slug: string) => `base.${slug}@${PERSONA_DOMAIN}`;

/** Vecindario de ejemplo que ve el Ayuntamiento: colonias en distintos estados, carnets y formación. */
async function seedBase(db: DB, ctx: Ctx) {
  const carmen = await createUser(db, { email: base("carmen"), nombre: "Carmen", apellidos: "López Ruiz", createdAt: ago(300) });
  const javier = await createUser(db, { email: base("javier"), nombre: "Javier", apellidos: "Martín Pérez", createdAt: ago(280) });
  const lucia = await createUser(db, { email: base("lucia"), nombre: "Lucía", apellidos: "Gómez Serrano", createdAt: ago(260) });
  const antonio = await createUser(db, { email: base("antonio"), nombre: "Antonio", apellidos: "Sánchez Villa", createdAt: ago(900) });
  const elena = await createUser(db, { email: base("elena"), nombre: "Elena", apellidos: "Castro Moreno", createdAt: ago(400) });
  const pilar = await createUser(db, { email: base("pilar"), nombre: "Pilar", apellidos: "Romero Díaz", createdAt: ago(20) });
  const sergio = await createUser(db, { email: base("sergio"), nombre: "Sergio", apellidos: "Navarro Gil", createdAt: ago(35) });
  await createUser(db, { email: base("ana"), nombre: "Ana", apellidos: "Ruiz Delgado", createdAt: ago(2) });

  for (const [id, n, d] of [
    [carmen, "todos", 290],
    [javier, "todos", 270],
    [lucia, "todos", 250],
    [antonio, "todos", 880],
    [elena, "todos", 390],
    [pilar, 5, 18],
    [sergio, "todos", 30],
  ] as const) {
    await passUnits(db, id, n, d);
  }

  // Carmen hace el examen final de verdad: su intento, corregido por JEV, se ve en «Intentos».
  let carmenCarnet = false;
  try {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, carmen) });
    const attemptId = await startFinalExam(db, u!);
    const { items } = await getAttemptForUser(db, attemptId, carmen);
    await submitAttempt(db, attemptId, carmen, exampleAnswers(items));
    carmenCarnet = Boolean(await db.query.carnets.findFirst({ where: eq(schema.carnets.userId, carmen) }));
  } catch (e) {
    console.error("Demo: el examen final de ejemplo no se ha podido corregir", e);
  }
  if (!carmenCarnet) await carnetFor(db, carmen, ago(240));
  await carnetFor(db, javier, ago(230));
  await carnetFor(db, lucia, ago(200));
  await carnetFor(db, elena, ago(350));

  // Sergio suspendió el examen final: intento sin detalle, para ver un «no apto» en el panel.
  await db.insert(schema.attempts).values({
    id: uuid(),
    userId: sergio,
    kind: "final",
    unitId: null,
    status: "failed",
    passPct: 70,
    scorePct: 55,
    correctCount: 11,
    totalCount: 20,
    startedAt: ago(4),
    submittedAt: ago(4),
  });

  // Carnet caducado (Antonio) y revocado (Elena).
  const s = await getSettings(db);
  const antonioCarnet = await issueCarnet(db, antonio, null, s);
  await db.update(schema.carnets).set({ issuedAt: ago(860), expiresAt: ago(130) }).where(eq(schema.carnets.id, antonioCarnet.id));
  await db.update(schema.carnets).set({ revokedAt: ago(15) }).where(eq(schema.carnets.userId, elena));

  // Colonias: una al día, otra con el censo pendiente y otra que se ha quedado sin cuidadores.
  const programa = await getPrograma(db);
  await colonyWith(db, {
    nombre: "Polideportivo municipal",
    direccion: "Calle del Deporte, s/n (trasera del polideportivo)",
    coordenadas: "40.0741, -4.4032",
    responsableId: carmen,
    colaboradores: [javier],
    censoDias: censoAlDia(programa),
    censo: [5, 1, 3, 1],
    gatos: GATOS_POLIDEPORTIVO,
  });
  await colonyWith(db, {
    nombre: "Plaza de la Iglesia",
    direccion: "Plaza de la Iglesia, 2 (patio trasero)",
    coordenadas: "40.0718, -4.4066",
    responsableId: lucia,
    censoDias: censoPendiente(programa) + 20,
    censo: [2, 2, 1, 2],
    gatos: GATOS_POLIDEPORTIVO.slice(1, 3).map((g) => ({ ...g, nota: undefined, intervenciones: [] })),
  });
  // Antonio cuidaba esta colonia y se dio de baja porque ya no quedan gatos (validado con JEV).
  const molino = await colonyWith(db, {
    nombre: "Camino del Molino",
    direccion: "Camino del Molino, km 1 (solar privado)",
    titularidad: "privado",
    responsableId: lucia,
    censoDias: Math.max(400, censoPendiente(programa) + 60),
    censo: [1, 0, 1, 0],
  });
  await db.insert(schema.colonyMembers).values({
    id: uuid(),
    colonyId: molino,
    userId: antonio,
    rol: "colaborador",
    since: ago(420),
    until: ago(9),
    bajaPor: "cuidador",
    bajaMotivo: "Los dos gatos que quedaban eran muy mayores y han fallecido este verano. Ya no queda ningún gato en la colonia.",
    bajaJev: {
      checks: [
        { id: "motivo", ok: true, label: "Motivo concreto" },
        { id: "relevo", ok: true, label: "Ya no quedan gatos" },
      ],
      scores: { motivo: 3.4, relevo: 0.12, sinGatos: 0.94, invalida: 0.03, simulado: false },
      gatosCenso: 2,
      jevDisponible: true,
      requiereRelevo: false,
    },
  });
  await db
    .update(schema.colonyMembers)
    .set({ until: ago(9), bajaPor: "ayuntamiento", bajaMotivo: "Colonia sin gatos: se da de baja a la responsable en esta colonia." })
    .where(and(eq(schema.colonyMembers.colonyId, molino), eq(schema.colonyMembers.userId, lucia)));
  await db.update(schema.colonies).set({ estado: "sin_cuidadores", updatedAt: ago(9) }).where(eq(schema.colonies.id, molino));

  await db.insert(schema.accessibilityReports).values({
    id: uuid(),
    tipo: "sugerencia",
    pagina: "/temario",
    descripcion: "Con el lector de pantalla del móvil, sería útil poder saltar directamente al test al final de cada tema.",
    nombre: "Ana",
    estado: "nueva",
    createdAt: ago(1),
  });

  void ctx; // los datos de base no generan avisos por correo
}
