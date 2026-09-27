import type { APIRoute } from "astro";
import { getDb } from "../../../lib/db";
import { isDemo } from "../../../lib/demo";
import { getProgress } from "../../../lib/exam";
import { demoPassUnit } from "../../../lib/demo-data";

/** Atajo de la demo: aprueba el tema sin hacer el test y lleva al siguiente. */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!isDemo()) return new Response("No encontrado", { status: 404 });
  const unitId = Number((await request.formData()).get("unitId"));
  const db = getDb();
  const { units } = await getProgress(db, locals.user!.id);
  const idx = units.findIndex((u) => u.id === unitId);
  if (idx === -1 || !units[idx].unlocked) return redirect("/temario", 303);
  if (!units[idx].passed) await demoPassUnit(db, locals.user!.id, unitId);
  const next = units[idx + 1];
  return redirect(next ? `/temario/${next.slug}?aprobado=${units[idx].orden}` : "/examen", 303);
};
