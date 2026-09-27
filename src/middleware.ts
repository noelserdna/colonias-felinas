import { demoGate, isDemo } from "./lib/demo";
import { defineMiddleware } from "astro:middleware";
import { getDb } from "./lib/db";
import { getSessionUser, SESSION_COOKIE } from "./lib/auth";
import { getIdentidad } from "./lib/programa";
import { getActiveCarnet } from "./lib/carnet";

const PUBLIC = [/^\/$/, /^\/login/, /^\/auth\//, /^\/api\/auth\//, /^\/privacidad/, /^\/accesibilidad/, /^\/documentos/, /^\/docs\//, /^\/offline/, /^\/branding\//, /^\/manifest\.webmanifest$/, /^\/demo$/, /^\/api\/demo\/(entrar|reset)$/];

export const onRequest = defineMiddleware(async (ctx, next) => {
  const db = getDb();
  const [user, identidad] = await Promise.all([getSessionUser(db, ctx.cookies.get(SESSION_COOKIE)?.value), getIdentidad(db)]);
  ctx.locals.user = user;
  ctx.locals.branding = identidad.branding;
  ctx.locals.programa = identidad.programa;
  ctx.locals.temario = identidad.temario;
  ctx.locals.hasCarnet = ctx.locals.user ? Boolean(await getActiveCarnet(db, ctx.locals.user.id)) : false;
  const path = ctx.url.pathname;
  const isApi = path.startsWith("/api/");
  const gate = await demoGate(ctx);
  if (gate) return gate;

  if (!PUBLIC.some((re) => re.test(path)) && !ctx.locals.user) {
    if (isApi) return new Response(JSON.stringify({ error: "No autenticado" }), { status: 401 });
    return ctx.redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  if ((path.startsWith("/admin") || path.startsWith("/api/admin")) && ctx.locals.user?.role !== "admin") {
    if (isApi) return new Response(JSON.stringify({ error: "Prohibido" }), { status: 403 });
    return ctx.redirect("/");
  }

  const res = await next();
  // Las páginas con datos personales no se guardan en cachés compartidas.
  if (isDemo()) res.headers.set("x-robots-tag", "noindex, nofollow");
  if (ctx.locals.user && !res.headers.has("cache-control") && !path.startsWith("/branding/")) res.headers.set("cache-control", "private, no-store");
  return res;
});
