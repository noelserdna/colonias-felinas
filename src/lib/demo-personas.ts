// Perfiles de la instancia demo, recorrido guiado y respuestas de ejemplo. Módulo puro (sin base de datos).

/** Dominio de los correos de los perfiles de demo: no existe, así que nunca se envía nada a ellos. */
export const PERSONA_DOMAIN = "personas.demo";

export type PersonaKey = "nueva" | "mitad" | "examen" | "carnet" | "responsable" | "ayuntamiento";

type Paso = { texto: string; href: string };

export const PERSONAS: Record<
  PersonaKey,
  { titulo: string; descripcion: string; aprobados: number | "todos"; carnet: boolean; colonia: boolean; admin: boolean; inicio: string; recorrido: Paso[] }
> = {
  nueva: {
    titulo: "Empieza el curso",
    descripcion: "Acaba de entrar: temario por delante y el primer test.",
    aprobados: 0,
    carnet: false,
    colonia: false,
    admin: false,
    inicio: "/",
    recorrido: [
      { texto: "Ver el inicio y el progreso del curso", href: "/" },
      { texto: "Leer el primer tema, con sus imágenes", href: "/temario" },
      { texto: "Hacer el test del tema (hay botón para rellenarlo)", href: "/temario" },
      { texto: "Ver cómo se desbloquea el tema siguiente", href: "/temario" },
    ],
  },
  mitad: {
    titulo: "A mitad del curso",
    descripcion: "Ha aprobado 4 de los {temas} temas.",
    aprobados: 4,
    carnet: false,
    colonia: false,
    admin: false,
    inicio: "/",
    recorrido: [
      { texto: "Ver el progreso: 4 de {temas} temas", href: "/" },
      { texto: "Temas aprobados, el siguiente y los bloqueados", href: "/temario" },
      { texto: "Aprobar un tema de un clic (atajo de la demo)", href: "/temario" },
    ],
  },
  examen: {
    titulo: "Lista para el examen final",
    descripcion: "Ha aprobado todos los temas. JEV corrige de verdad sus respuestas escritas.",
    aprobados: "todos",
    carnet: false,
    colonia: false,
    admin: false,
    inicio: "/examen",
    recorrido: [
      { texto: "Empezar el examen final ({preguntas} preguntas)", href: "/examen" },
      { texto: "Rellenar con respuestas de ejemplo y enviarlo", href: "/examen" },
      { texto: "Ver la corrección de JEV y los fallos", href: "/examen" },
      { texto: "Recibir el carnet digital", href: "/carnet" },
    ],
  },
  carnet: {
    titulo: "Cuidadora con carnet",
    descripcion: "Acreditada, todavía sin colonia: quiere registrar una.",
    aprobados: "todos",
    carnet: true,
    colonia: false,
    admin: false,
    inicio: "/",
    recorrido: [
      { texto: "El carnet digital (anverso, reverso y hora en directo)", href: "/" },
      { texto: "Guía para solicitar el alta de una colonia", href: "/colonia" },
      { texto: "Rellenar la solicitud de registro y descargar el PDF", href: "/colonia/solicitud" },
      { texto: "Autorización de la persona propietaria", href: "/colonia/solicitud?anexo=aut" },
      { texto: "Temario en modo consulta", href: "/temario" },
      { texto: "Normativa y formularios", href: "/documentos" },
    ],
  },
  responsable: {
    titulo: "Responsable de una colonia",
    descripcion: "El Ayuntamiento acaba de registrar su colonia, con gatos, fotos y censo.",
    aprobados: "todos",
    carnet: true,
    colonia: true,
    admin: false,
    inicio: "/",
    recorrido: [
      { texto: "Aviso «Tu colonia ya está registrada»", href: "/" },
      { texto: "La colonia en el carnet", href: "/carnet" },
      { texto: "Gestión de la colonia: censo y gatos", href: "/colonia" },
      { texto: "Ficha de un gato con foto, intervenciones y observaciones", href: "/colonia" },
      { texto: "Actualizar el censo (toca hacerlo)", href: "/colonia" },
      { texto: "Dejar de colaborar: explicación validada con JEV", href: "/colonia" },
      { texto: "El correo que ha recibido", href: "/demo/correos" },
    ],
  },
  ayuntamiento: {
    titulo: "Personal del Ayuntamiento",
    descripcion: "Panel de administración con colonias, personas cuidadoras y exámenes.",
    aprobados: 0,
    carnet: false,
    colonia: false,
    admin: true,
    inicio: "/admin",
    recorrido: [
      { texto: "Resumen del panel", href: "/admin" },
      { texto: "Colonias: registro, cuidadores y bajas", href: "/admin/colonias" },
      { texto: "Registrar una colonia nueva", href: "/admin/colonias/nueva" },
      { texto: "Personas, su progreso y cada examen corregido por JEV (p. ej. Carmen)", href: "/admin/usuarios" },
      { texto: "Carnets emitidos", href: "/admin/carnets" },
      { texto: "Banco de preguntas por tema y dificultad", href: "/admin/preguntas" },
      { texto: "Ajustes (en la demo no se guardan)", href: "/admin/ajustes" },
    ],
  },
};

export const PERSONA_KEYS = Object.keys(PERSONAS) as PersonaKey[];

/** Datos del curso que dependen del temario activo y de los ajustes (sustituyen a {temas} y {preguntas}). */
export type CursoDemo = { temas: number; preguntas: number };

/** Perfil con los textos completados con los datos del curso actual. */
export function personaConTextos(key: PersonaKey, curso: CursoDemo) {
  const p = PERSONAS[key];
  const t = (s: string) => s.replace(/\{temas\}/g, String(curso.temas)).replace(/\{preguntas\}/g, String(curso.preguntas));
  return { ...p, descripcion: t(p.descripcion), recorrido: p.recorrido.map((r) => ({ ...r, texto: t(r.texto) })) };
}

/** Correo de un perfil de demo: `<perfil>.<aleatorio>@personas.demo`. */
export function personaEmail(key: PersonaKey, rand: string) {
  return `${key}.${rand}@${PERSONA_DOMAIN}`;
}

/** Perfil de demo al que pertenece un correo, o null si no es de la demo. */
export function personaOf(email: string | null | undefined): PersonaKey | null {
  const m = email?.match(/^([a-z]+)\.[a-z0-9]+@personas\.demo$/);
  return m && (PERSONA_KEYS as string[]).includes(m[1]) ? (m[1] as PersonaKey) : null;
}

const NOMBRES = [
  ["Rosa", "Martín Gil"],
  ["Laura", "Sánchez Moreno"],
  ["Manuel", "García Ortega"],
  ["Isabel", "Fernández Rubio"],
  ["Pablo", "Jiménez Castro"],
  ["Nuria", "Hernández Prieto"],
  ["Andrés", "Muñoz Vega"],
  ["Teresa", "Álvarez Ramos"],
  ["Diego", "Romero Molina"],
  ["Cristina", "Navarro Iglesias"],
] as const;

export function randomName(seed: number) {
  const [nombre, apellidos] = NOMBRES[Math.abs(seed) % NOMBRES.length];
  return { nombre, apellidos };
}

// ---------- Respuestas de ejemplo ----------

type ItemParaRellenar = {
  position: number;
  optionOrder: number[] | null;
  snapshot: { type: "mc" | "multi" | "written"; options?: string[]; correctIndex?: number; correctIndexes?: number[]; referenceAnswer?: string | null };
};

export const RESPUESTA_FLOJA = "Creo que hay que darles de comer y ya está, no sé mucho más de este tema.";

/**
 * Respuestas de ejemplo para enseñar el test o el examen sin contestarlo a mano: casi todas bien y,
 * con `fallos`, una de tipo test mal y una escrita floja, para que se vea cómo corrige cada una.
 * Devuelve el índice MOSTRADO de cada opción (el navegador ve las opciones barajadas).
 */
export function exampleAnswers(items: ItemParaRellenar[], fallos = true): Record<string, number | number[] | string> {
  const out: Record<string, number | number[] | string> = {};
  const shown = (order: number[] | null, original: number) => (order ? order.indexOf(original) : original);
  const objective = items.filter((i) => i.snapshot.type !== "written");
  const written = items.filter((i) => i.snapshot.type === "written");
  const mcFallo = fallos && objective.length > 3 ? objective[objective.length - 1].position : null;
  const writtenFloja = fallos && written.length > 1 ? written[written.length - 1].position : null;
  for (const it of items) {
    const s = it.snapshot;
    if (s.type === "mc") {
      const right = shown(it.optionOrder, s.correctIndex ?? 0);
      const n = s.options?.length ?? 2;
      out[String(it.position)] = it.position === mcFallo ? (right + 1) % n : right;
    } else if (s.type === "multi") {
      out[String(it.position)] = (s.correctIndexes ?? []).map((c) => shown(it.optionOrder, c)).sort((a, b) => a - b);
    } else {
      out[String(it.position)] = it.position === writtenFloja ? RESPUESTA_FLOJA : (s.referenceAnswer ?? "").trim() || RESPUESTA_FLOJA;
    }
  }
  return out;
}
