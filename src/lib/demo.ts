import { env } from "cloudflare:workers";
import type { APIContext } from "astro";
import { sha256 } from "./util";

/** Instancia de pruebas y demostración (variable DEMO=1): se marca en toda la web y en los carnets. */
export const isDemo = () => env.DEMO === "1";

export const DEMO_COOKIE = "demo_acceso";

/** Páginas que se ven sin el enlace con código (la portada de la demo y la información legal). */
const OPEN = [/^\/demo$/, /^\/privacidad/, /^\/accesibilidad$/, /^\/offline/, /^\/branding\//, /^\/manifest\.webmanifest$/, /^\/api\/demo\/reset$/];

/** En la demo, los contenidos y los ajustes se pueden ver pero no cambiar (el reinicio no los restaura). */
const LOCKED = [/^\/admin\/(temarios|temas|preguntas|ajustes|documentos|programa|textos)(\/|$)/, /^\/admin\/colonia\/?$/, /^\/api\/admin\/(questions|temarios)/];

/**
 * Reglas de la instancia demo: acceso con el enlace con código (?codigo=…, se recuerda en una cookie),
 * sin acceso por correo (se entra eligiendo un perfil) y contenidos de solo lectura.
 * Devuelve una respuesta si hay que cortar la petición, o null para seguir.
 */
export async function demoGate(ctx: APIContext): Promise<Response | null> {
  if (!isDemo()) return null;
  const path = ctx.url.pathname;
  const isApi = path.startsWith("/api/");
  const code = env.DEMO_CODE?.trim();

  const q = ctx.url.searchParams.get("codigo");
  if (q !== null) {
    if (!code || q.trim() !== code) return ctx.redirect("/demo?codigo=incorrecto", 303);
    ctx.cookies.set(DEMO_COOKIE, await sha256(code), { httpOnly: true, secure: ctx.url.protocol === "https:", sameSite: "lax", path: "/", maxAge: 60 * 86_400 });
    const clean = new URL(ctx.url);
    clean.searchParams.delete("codigo");
    return ctx.redirect(clean.pathname === "/" ? "/demo" : clean.pathname + clean.search, 303);
  }

  const ok = !code || ctx.cookies.get(DEMO_COOKIE)?.value === (await sha256(code));
  ctx.locals.demoAccess = ok;
  if (!ok && !OPEN.some((re) => re.test(path))) {
    return isApi ? new Response(JSON.stringify({ error: "Necesitas el enlace de la demo" }), { status: 403 }) : ctx.redirect("/demo");
  }
  // En la demo no se entra con correo: se elige un perfil.
  if (/^\/(login|auth\/|api\/auth\/)/.test(path) || (path === "/" && !ctx.locals.user)) return ctx.redirect("/demo");
  if (ctx.request.method !== "GET" && LOCKED.some((re) => re.test(path))) {
    return isApi
      ? new Response(JSON.stringify({ error: "En la demo no se pueden cambiar los contenidos ni los ajustes." }), { status: 403 })
      : ctx.redirect(`${path}?bloqueado=1`, 303);
  }
  return null;
}
