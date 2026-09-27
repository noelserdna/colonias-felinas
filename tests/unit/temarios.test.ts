import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  construirPaquete,
  elegirTemarioActivo,
  impactoCambio,
  resolveUnit,
  TEMARIO_DEFECTO,
  validarPaquete,
  type DatosImpacto,
} from "../../src/lib/temarios-config";
import { personaConTextos } from "../../src/lib/demo-personas";

describe("temario activo", () => {
  const temarios = [
    { id: "toledo-2025", oculto: false, temasActivos: 8 },
    { id: "propio", oculto: false, temasActivos: 11 },
    { id: "vacio", oculto: false, temasActivos: 0 },
    { id: "viejo", oculto: true, temasActivos: 5 },
  ];

  it("usa el guardado si tiene temas y está visible", () => {
    expect(elegirTemarioActivo("propio", temarios)).toBe("propio");
  });

  it("sin elección guardada (o no válida) usa el de por defecto", () => {
    expect(elegirTemarioActivo(undefined, temarios)).toBe(TEMARIO_DEFECTO);
    expect(elegirTemarioActivo("no-existe", temarios)).toBe(TEMARIO_DEFECTO);
    expect(elegirTemarioActivo("vacio", temarios)).toBe(TEMARIO_DEFECTO);
    expect(elegirTemarioActivo("viejo", temarios)).toBe(TEMARIO_DEFECTO);
    expect(elegirTemarioActivo(42, temarios)).toBe(TEMARIO_DEFECTO);
  });

  it("si el de por defecto no tiene temas (instalación sin el manual de Toledo), el primero con temas", () => {
    const sinToledo = [{ id: "toledo-2025", oculto: false, temasActivos: 0 }, ...temarios.slice(1)];
    expect(elegirTemarioActivo(undefined, sinToledo)).toBe("propio");
  });

  it("sin temarios devuelve el de por defecto", () => {
    expect(elegirTemarioActivo(undefined, [])).toBe(TEMARIO_DEFECTO);
  });
});

describe("resolución de temas dentro de un temario", () => {
  // Los dos temarios repiten el slug `metodo-cer` y el orden 5.
  const units = [
    { id: 5, temarioId: "toledo-2025", slug: "metodo-cer", orden: 5 },
    { id: 7, temarioId: "toledo-2025", slug: "programa-municipal", orden: 7 },
    { id: 21, temarioId: "propio", slug: "reproduccion-y-gatitos", orden: 5 },
    { id: 25, temarioId: "propio", slug: "metodo-cer", orden: 9 },
  ];

  it("por slug, sin salirse del temario", () => {
    expect(resolveUnit(units, "toledo-2025", "metodo-cer")?.id).toBe(5);
    expect(resolveUnit(units, "propio", "metodo-cer")?.id).toBe(25);
  });

  it("por orden (número o texto), sin salirse del temario", () => {
    expect(resolveUnit(units, "toledo-2025", 5)?.id).toBe(5);
    expect(resolveUnit(units, "propio", 5)?.id).toBe(21);
    expect(resolveUnit(units, "propio", "9")?.id).toBe(25);
  });

  it("no encuentra temas de otro temario", () => {
    expect(resolveUnit(units, "propio", "programa-municipal")).toBeUndefined();
    expect(resolveUnit(units, "propio", 7)).toBeUndefined();
    expect(resolveUnit(units, "otro", "metodo-cer")).toBeUndefined();
  });
});

const paqueteBase = () => ({
  formato: "temario-colonias",
  version: 1,
  temario: { id: "prueba", nombre: "Temario de prueba", credito: "Autoría X (CC BY 4.0)" },
  temas: [
    { slug: "uno", orden: 1, titulo: "Tema uno", peso: 1, activo: true, contenido: "# Uno" },
    { slug: "dos", orden: 2, titulo: "Tema dos", contenido: "# Dos" },
  ],
  preguntas: [
    { tema: "uno", tipo: "mc", enunciado: "¿Primera pregunta?", opciones: ["A", "B"], correcta: 0 },
    { tema: 2, tipo: "written", enunciado: "Explica el tema dos", respuesta_referencia: "Así" },
  ],
});

describe("paquete de temario", () => {
  it("acepta un paquete correcto y resuelve el tema de cada pregunta a su slug", () => {
    const r = validarPaquete(paqueteBase());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paquete.temario).toMatchObject({ id: "prueba", descripcion: null });
    expect(r.paquete.temas[1]).toMatchObject({ peso: 1, activo: true });
    expect(r.paquete.preguntas.map((q) => q.tema)).toEqual(["uno", "dos"]);
  });

  it("rechaza lo que no es un paquete", () => {
    expect(validarPaquete([]).ok).toBe(false);
    const r = validarPaquete({ ...paqueteBase(), formato: "otra-cosa" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/temario-colonias/);
  });

  it("rechaza identificadores no válidos, temas repetidos y paquetes sin temas", () => {
    expect(validarPaquete({ ...paqueteBase(), temario: { id: "Con Espacios", nombre: "x" } }).ok).toBe(false);
    expect(validarPaquete({ ...paqueteBase(), temas: [] }).ok).toBe(false);
    const p = paqueteBase();
    p.temas[1] = { ...p.temas[1], slug: "uno" };
    const r = validarPaquete(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores).toContain("Tema repetido: uno");
  });

  it("todo o nada: una sola pregunta mal hace fallar el paquete entero", () => {
    const p = paqueteBase();
    p.preguntas.push({ tema: "uno", tipo: "mc", enunciado: "¿Opción inexistente?", opciones: ["A", "B"], correcta: 5 });
    p.preguntas.push({ tema: "tres", tipo: "mc", enunciado: "¿Tema que no existe?", opciones: ["A", "B"], correcta: 0 });
    const r = validarPaquete(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errores.some((e) => e.startsWith("Pregunta 3:"))).toBe(true);
      expect(r.errores).toContain("Pregunta 4: tema desconocido tres");
    }
  });

  it("ida y vuelta: exportar y volver a validar da el mismo temario", () => {
    const units = [
      { id: 12, slug: "dos", orden: 2, titulo: "Tema dos", peso: 0.5, activo: false, contenido: "# Dos" },
      { id: 11, slug: "uno", orden: 1, titulo: "Tema uno", peso: 1, activo: true, contenido: "# Uno ![foto](/img/curso/x.jpg)" },
    ];
    const q = (unitId: number, enunciado: string) => ({
      unitId,
      type: "multi" as const,
      dificultad: "alta" as const,
      enunciado,
      options: ["a", "b", "c"],
      correctIndex: null,
      correctIndexes: [0, 2],
      explicacion: null,
      referenceAnswer: null,
      keyPoints: null,
      activo: true,
    });
    const paquete = construirPaquete({ id: "exportado", nombre: "Exportado", descripcion: null, credito: null }, units, [q(11, "¿Cuáles valen?"), q(12, "¿Y aquí cuáles?"), q(99, "De otro temario")]);
    expect(paquete.temas.map((t) => t.slug)).toEqual(["uno", "dos"]);
    expect(paquete.preguntas).toHaveLength(2);
    const r = validarPaquete(JSON.parse(JSON.stringify(paquete)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.paquete.temas[1]).toMatchObject({ peso: 0.5, activo: false });
      expect(r.paquete.preguntas[1]).toMatchObject({ tema: "dos", tipo: "multi", correctas: [0, 2], dificultad: "alta" });
    }
  });

  it("el temario propio del repositorio cabe en un paquete válido", () => {
    const dir = "seed/temario-propio";
    const units = JSON.parse(readFileSync(`${dir}/units.json`, "utf8")) as { slug: string; orden: number; titulo: string; peso: number }[];
    const temas = units.map((u) => ({ ...u, contenido: readFileSync(`${dir}/units/${String(u.orden).padStart(2, "0")}-${u.slug}.md`, "utf8") }));
    let preguntas: unknown[] = [];
    try {
      preguntas = units.flatMap((u) => JSON.parse(readFileSync(`${dir}/questions/${String(u.orden).padStart(2, "0")}-${u.slug}.json`, "utf8")));
    } catch {
      // Sin el banco de preguntas (aún no está en git en todas las copias) se valida solo el texto.
    }
    const r = validarPaquete({ formato: "temario-colonias", version: 1, temario: { id: "propio", nombre: "Temario propio" }, temas, preguntas });
    expect(r.ok, r.ok ? "" : r.errores.join("\n")).toBe(true);
  });
});

describe("impacto de cambiar de temario", () => {
  const base: DatosImpacto = {
    temasDestino: 11,
    avisosCobertura: [],
    personasConProgreso: 0,
    testsEnCurso: 0,
    finalesEnCurso: 0,
    finalesEnCorreccion: 0,
    carnetsVigentes: 0,
  };

  it("bloquea activar un temario sin temas activos", () => {
    const r = impactoCambio({ ...base, temasDestino: 0 });
    expect(r.bloqueo).toMatch(/no tiene temas activos/);
  });

  it("sin nadie en curso solo recuerda que los carnets no cambian", () => {
    const r = impactoCambio(base);
    expect(r.bloqueo).toBeNull();
    expect(r.avisos).toEqual(["0 carnets vigentes no cambian: quienes tienen carnet consultarán el nuevo temario."]);
  });

  it("cuenta personas con progreso, intentos en curso y finales en corrección (singular y plural)", () => {
    const r = impactoCambio({ ...base, personasConProgreso: 3, testsEnCurso: 1, finalesEnCurso: 2, finalesEnCorreccion: 1, carnetsVigentes: 1, avisosCobertura: ["Faltan escritas"] });
    const txt = r.avisos.join("\n");
    expect(txt).toMatch(/3 personas sin carnet tienen temas aprobados/);
    expect(txt).toMatch(/lo recuperan si se vuelve a activar/);
    expect(txt).toMatch(/1 test de tema en curso quedará sin efecto/);
    expect(txt).toMatch(/2 exámenes finales sin enviar quedarán anulados/);
    expect(txt).toMatch(/1 examen final enviado se está corrigiendo: terminará igual/);
    expect(txt).toMatch(/1 carnet vigente no cambia/);
    expect(txt).toMatch(/Banco de preguntas: Faltan escritas/);
  });
});

describe("textos de los perfiles de la demo", () => {
  it("usan el número de temas del temario activo y de preguntas del examen", () => {
    const mitad = personaConTextos("mitad", { temas: 11, preguntas: 20 });
    expect(mitad.descripcion).toBe("Ha aprobado 4 de los 11 temas.");
    expect(mitad.recorrido[0].texto).toBe("Ver el progreso: 4 de 11 temas");
    expect(personaConTextos("examen", { temas: 8, preguntas: 25 }).recorrido[0].texto).toBe("Empezar el examen final (25 preguntas)");
  });
});
