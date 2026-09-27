import type { APIRoute } from "astro";
import { getDb } from "../../../../../lib/db";
import { exportarTemario } from "../../../../../lib/temarios";

/** Paquete JSON de un temario completo (metadatos, temas con su Markdown y preguntas) para importarlo en otra instalación. */
export const GET: APIRoute = async ({ params }) => {
  const paquete = await exportarTemario(getDb(), params.id!);
  if (!paquete) return new Response(JSON.stringify({ error: "Temario no encontrado" }), { status: 404 });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(paquete, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="temario-${paquete.temario.id}-${date}.json"` },
  });
};
