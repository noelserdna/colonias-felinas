import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";

import { existsSync, readFileSync } from "node:fs";

// Correo de administración para las pruebas: E2E_ADMIN_EMAIL o el primero de ADMIN_EMAILS en .dev.vars.
const devVarsAdmin = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8").match(/^ADMIN_EMAILS=([^,\s]+)/m)?.[1] : undefined;
const ADMIN = process.env.E2E_ADMIN_EMAIL ?? devVarsAdmin ?? "admin@example.org";

// La sesión del administrador se reutiliza entre pruebas: el acceso tiene un límite de
// 5 enlaces por minuto y correo, y varias pruebas entran como administrador.
let adminCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | null = null;

async function login(page: Page, email: string) {
  if (email === ADMIN && adminCookies) {
    await page.context().addCookies(adminCookies);
    await page.goto("/");
    return;
  }
  await page.goto("/login");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByRole("button", { name: "Enviarme el enlace" }).click();
  await page.getByTestId("dev-link").click();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
  if (email === ADMIN) adminCookies = await page.context().cookies();
}

type Bank = { enunciado: string; tipo: "mc" | "multi" | "written"; opciones?: string[]; correcta?: number; correctas?: number[]; respuesta_referencia?: string }[];

/** Temario activo (id) y slugs de sus temas activos, en orden, leídos del panel. */
async function activeTemario(admin: BrowserContext): Promise<{ id: string; slugs: string[] }> {
  const page = await admin.newPage();
  await page.goto("/admin/temarios");
  const row = page.locator("tr", { has: page.locator(".badge", { hasText: /^activo$/ }) });
  const href = (await row.getByRole("link", { name: /^Editar el temario/ }).getAttribute("href"))!;
  await page.close();
  const id = href.split("/").pop()!;
  const res = await admin.request.get(`/api/admin/temarios/${id}/export`);
  expect(res.ok()).toBeTruthy();
  const paquete = (await res.json()) as { temas: { slug: string; activo: boolean }[] };
  return { id, slugs: paquete.temas.filter((t) => t.activo).map((t) => t.slug) };
}

/** Deja activo el temario indicado (con la confirmación de la propia página). */
async function activar(admin: Page, id: string) {
  await admin.goto(`/admin/temarios/${id}/activar`);
  if (await admin.getByText("Este temario ya es el activo").count()) return;
  await admin.getByLabel(/Entiendo lo que cambia/).check();
  await admin.getByRole("button", { name: "Activar el temario" }).click();
  await expect(admin.getByText("Temario activado.")).toBeVisible();
}

/** Banco de preguntas del temario activo (o del indicado). */
async function exportBank(admin: BrowserContext, temario?: string): Promise<Map<string, Bank[number]>> {
  const res = await admin.request.get(`/api/admin/questions/export?format=json${temario ? `&temario=${temario}` : ""}`);
  expect(res.ok()).toBeTruthy();
  const bank = (await res.json()) as Bank;
  return new Map(bank.map((q) => [q.enunciado, q]));
}

/** Responde todas las preguntas visibles: bien (usando el banco exportado) o mal. */
async function answerAll(page: Page, bank: Map<string, Bank[number]>, correct: boolean) {
  const questions = page.locator("fieldset.question");
  await expect(questions.first()).toBeVisible();
  const n = await questions.count();
  for (let i = 0; i < n; i++) {
    const fs = questions.nth(i);
    const text = (await fs.locator(".qtext").innerText()).trim();
    const q = bank.get(text);
    expect(q, `Pregunta no encontrada en el banco: ${text}`).toBeTruthy();
    if (q!.tipo === "multi") {
      const right = new Set(q!.correctas!.map((i) => q!.opciones![i]));
      const labels = fs.locator("label.option");
      const count = await labels.count();
      for (let j = 0; j < count; j++) {
        const t = (await labels.nth(j).innerText()).trim();
        // Bien: marcar exactamente las correctas. Mal: marcar solo una incorrecta.
        if (correct ? right.has(t) : !right.has(t)) {
          await labels.nth(j).click();
          if (!correct) break;
        }
      }
    } else if (q!.tipo === "mc") {
      const right = q!.opciones![q!.correcta!];
      const labels = fs.locator("label.option");
      const count = await labels.count();
      for (let j = 0; j < count; j++) {
        const t = (await labels.nth(j).innerText()).trim();
        if ((t === right) === correct) {
          await labels.nth(j).click();
          break;
        }
      }
    } else {
      await fs.locator("textarea").fill(correct ? q!.respuesta_referencia! : "No lo sé.");
    }
  }
}

test("flujo completo: temas, examen final, carnet y revocación", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, ADMIN);
  const bank = await exportBank(adminCtx);
  expect(bank.size).toBeGreaterThan(0);
  const temario = await activeTemario(adminCtx);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = `e2e-${Date.now()}@example.org`;
  await login(page, email);

  // Un usuario normal no puede entrar al panel.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
  expect((await ctx.request.get("/api/admin/questions/export")).status()).toBe(403);

  // Perfil.
  await page.goto("/perfil");
  await page.getByLabel("Nombre").fill("Lucía");
  await page.getByLabel("Apellidos").fill("Prueba García");
  await page.locator('input[name="consent"]').check();
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Datos guardados.")).toBeVisible();

  // El tema 2 está bloqueado al principio y el examen final también.
  await page.goto("/examen");
  await expect(page.getByText("Aprueba todos los temas")).toBeVisible();

  await page.goto("/");
  const unitItems = page.locator("ol.path > li:not(.final):not(.extra)");
  const units = await unitItems.count();
  expect(units).toBe(temario.slugs.length);
  // El suplemento local (si hay) va aparte, sin test.
  if (await page.locator("ol.path > li.extra").count()) await expect(page.locator("ol.path > li.extra a")).toHaveAttribute("href", "/temario/local");
  await expect(unitItems.nth(1)).toHaveClass(/locked/);
  await expect(unitItems.nth(1).locator("a")).toHaveCount(0);

  for (let u = 0; u < units; u++) {
    await page.goto("/");
    await page.locator("ol.path > li:not(.final):not(.extra)").nth(u).locator("a").click();
    await page.getByRole("link", { name: "Hacer el test" }).click();

    if (u === 0) {
      // Primer intento del tema 1: suspender y comprobar el repaso.
      await page.getByRole("button", { name: "Empezar el test" }).click();
      await answerAll(page, bank, false);
      await page.getByRole("button", { name: "Enviar respuestas" }).click();
      await expect(page.getByText("No aprobado")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Repaso" })).toBeVisible();
      await page.getByRole("button", { name: "Repetir con otras preguntas" }).click();
    } else {
      await page.getByRole("button", { name: "Empezar el test" }).click();
    }
    await answerAll(page, bank, true);
    await page.getByRole("button", { name: "Enviar respuestas" }).click();
    await expect(page.getByText("Aprobado", { exact: true })).toBeVisible();
    await expect(page.locator(".big-score")).toHaveText("100%");
  }

  // Examen final (las respuestas escritas las corrige JEV).
  await page.goto("/examen");
  await page.getByRole("button", { name: "Empezar el examen final" }).click();
  await expect(page.locator("fieldset.question")).toHaveCount(20);
  await expect(page.locator("fieldset.question textarea")).toHaveCount(5);
  await answerAll(page, bank, true);
  await page.getByRole("button", { name: "Enviar respuestas" }).click();
  await expect(page.getByText("Aprobado", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Se ha emitido tu carnet/)).toBeVisible();

  await page.goto("/carnet");
  await expect(page.locator(".carnet.front")).toContainText("Lucía");
  await expect(page.locator(".carnet.front")).toContainText("Prueba García");
  const numero = (await page.locator(".carnet.front .c-number").innerText()).trim();
  expect(numero).toMatch(/^SRM-CF-\d{4}-\d{4}$/);
  await expect(page.locator(".front .c-live")).toContainText("Vigente");
  await expect(page.locator(".front [data-live-clock]")).not.toBeEmpty();
  // Escudo en las dos caras y giro al reverso.
  await expect(page.locator(".carnet .c-side img")).toHaveCount(2);
  await page.getByRole("button", { name: "Ver reverso" }).click();
  await expect(page.locator("[data-carnet-flip]")).toHaveAttribute("data-flipped", "true");
  await expect(page.locator(".carnet.back")).toContainText("Personal e intransferible");

  // Con carnet vigente: el carnet es la pantalla principal y el temario queda solo para consulta.
  const tabs = page.locator("nav.tabbar a");
  await page.goto("/");
  await expect(page.locator(".carnet.front")).toContainText(numero);
  await expect(tabs).toHaveText(["Carnet", "Colonia", "Consulta", "Perfil"]);
  await page.goto("/examen");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/temario");
  await expect(page.locator(".consult-list li")).toHaveCount(temario.slugs.length);
  await expect(page.getByRole("heading", { name: "Documentos del Ayuntamiento" })).toBeVisible();
  await page.locator(".consult-list a").nth(2).click();
  await expect(page.locator("article.prose")).toBeVisible();
  await expect(page.getByRole("link", { name: "Hacer el test" })).toHaveCount(0);
  await page.goto(`/temario/${temario.slugs[0]}/test`);
  await expect(page).toHaveURL(new RegExp(`/temario/${temario.slugs[0]}$`));
  // En «Mi colonia», el primer paso (acreditación) aparece completado.
  await page.goto("/colonia");
  await expect(page.locator(".colonia-step").first()).toHaveClass(/done/);

  // El admin revoca el carnet.
  await admin.goto("/admin/carnets");
  const row = admin.locator("tr", { hasText: numero });
  await row.getByRole("button", { name: "Revocar" }).click();
  await expect(admin.locator("tr", { hasText: numero }).getByText("revocado")).toBeVisible();

  await page.goto("/carnet");
  await expect(page.locator(".front .c-stamp")).toHaveText("REVOCADO");
  // Sin carnet vigente vuelve la navegación normal (para poder renovarlo).
  await page.goto("/");
  await expect(tabs).toHaveText(["Temario", "Examen", "Carnet", "Perfil"]);

  // El admin ve el detalle del examen con las puntuaciones de JEV.
  await admin.goto("/admin/usuarios");
  await admin.locator("tr", { hasText: email }).getByRole("link", { name: "Ver" }).click();
  await admin.locator("tr", { hasText: "Examen final" }).getByRole("link", { name: "Detalle" }).click();
  await expect(admin.getByText(/JEV · puntuación/).first()).toBeVisible();
});

test("los ajustes del panel se aplican al siguiente test", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/ajustes");
  const field = admin.getByLabel("Preguntas por test de tema");
  const original = await field.inputValue();
  await field.fill("4");
  await admin.getByRole("button", { name: "Guardar ajustes" }).click();
  await expect(admin.getByText("Ajustes guardados")).toBeVisible();

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, `e2e-ajustes-${Date.now()}@example.org`);
    await page.locator("ol.path > li:not(.final) a").first().click();
    await page.getByRole("link", { name: "Hacer el test" }).click();
    await page.getByRole("button", { name: "Empezar el test" }).click();
    await expect(page.locator("fieldset.question")).toHaveCount(4);
  } finally {
    await admin.goto("/admin/ajustes");
    await admin.getByLabel("Preguntas por test de tema").fill(original);
    await admin.getByRole("button", { name: "Guardar ajustes" }).click();
  }
});

test("ajustes del ayuntamiento, escudo y clave de JEV", async ({ browser }) => {
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/ajustes");
  const ayto = admin.locator("#ayuntamiento");

  try {
    // Un fichero que no es imagen se rechaza.
    await ayto.getByLabel("Municipio").fill("Villaprueba del Monte");
    await ayto.getByLabel("Provincia").fill("Madrid");
    await ayto.locator('input[type="file"]').setInputFiles({ name: "falso.png", mimeType: "image/png", buffer: Buffer.from("no soy una imagen") });
    await ayto.getByRole("button", { name: "Guardar ayuntamiento" }).click();
    await expect(admin.locator("#ayuntamiento .alert.bad")).toContainText("PNG, JPG o WebP");

    // Municipio y escudo válidos.
    await admin.locator("#ayuntamiento").getByLabel("Municipio").fill("Villaprueba del Monte");
    await admin.locator("#ayuntamiento").getByLabel("Provincia").fill("Madrid");
    await admin.locator('#ayuntamiento input[type="file"]').setInputFiles("public/icons/icon-192.png");
    await admin.locator("#ayuntamiento").getByRole("button", { name: "Guardar ayuntamiento" }).click();
    await expect(admin.locator("#ayuntamiento .alert.ok")).toBeVisible();
    await expect(admin.locator(".brand small")).toHaveText("Villaprueba del Monte");
    const src = await admin.locator(".escudo-preview img").getAttribute("src");
    expect(src).toMatch(/^\/branding\/escudo\?v=\w+/);
    const img = await ctx.request.get(src!);
    expect(img.headers()["content-type"]).toBe("image/png");
    expect(img.headers()["cache-control"]).toContain("immutable");
    expect(await (await ctx.request.get("/manifest.webmanifest")).text()).toContain("Villaprueba del Monte");

    // Clave de JEV: se guarda cifrada, no se muestra y una clave falsa no conecta.
    const jev = admin.locator("#jev");
    await jev.getByLabel(/clave/i).fill("apikey_clave_falsa_para_pruebas_e2e_9876");
    await jev.getByRole("button", { name: "Guardar clave" }).click();
    await expect(admin.locator("#jev")).toContainText("termina en …9876");
    expect(await admin.content()).not.toContain("apikey_clave_falsa_para_pruebas_e2e_9876");
    await admin.locator("#jev").getByRole("button", { name: "Probar conexión" }).click();
    await expect(admin.locator("#jev .alert.bad")).toContainText("JEV");
    await admin.locator("#jev").getByRole("button", { name: /Quitar la clave del panel/ }).click();
    await expect(admin.locator("#jev")).toContainText("Usando la clave del servidor");
    await admin.locator("#jev").getByRole("button", { name: "Probar conexión" }).click();
    await expect(admin.locator("#jev .alert.ok")).toContainText("Conexión correcta", { timeout: 30_000 });

    // Correo: remitente y clave de Resend validados; la clave se guarda cifrada y no se muestra.
    const correo = () => admin.locator("#correo");
    await correo().getByLabel("Remitente").fill("sin arroba");
    await correo().getByRole("button", { name: "Guardar remitente" }).click();
    await expect(correo().locator(".alert.bad")).toContainText("remitente no es válido");
    await correo().getByLabel("Remitente").fill("Colonias Felinas · Villaprueba <no-reply@avisos.villaprueba.es>");
    await correo().getByRole("button", { name: "Guardar remitente" }).click();
    await expect(correo()).toContainText("Remitente: Colonias Felinas · Villaprueba <no-reply@avisos.villaprueba.es>");
    await correo().getByLabel(/Clave de Resend/).fill("apikey_no_es_de_resend");
    await correo().getByRole("button", { name: "Guardar clave" }).click();
    await expect(correo().locator(".alert.bad")).toContainText("re_");
    await correo().getByLabel(/Clave de Resend/).fill("re_clave_falsa_para_pruebas_4321");
    await correo().getByRole("button", { name: "Guardar clave" }).click();
    await expect(correo()).toContainText("termina en …4321");
    expect(await admin.content()).not.toContain("re_clave_falsa_para_pruebas_4321");
    // En desarrollo (MAIL_MOCK=1) el envío es simulado: no sale nada hacia Resend.
    await correo().getByRole("button", { name: "Enviarme un correo de prueba" }).click();
    await expect(correo().locator(".alert.ok")).toContainText("simulado");
    await correo().getByRole("button", { name: "Quitar la clave de Resend" }).click();
    await expect(correo()).toContainText("Sin clave en el panel");
    await correo().getByLabel("Remitente").fill("");
    await correo().getByRole("button", { name: "Guardar remitente" }).click();
    await expect(correo().locator(".alert.ok")).toContainText("se usa el del servidor");
  } finally {
    await admin.goto("/admin/ajustes");
    await admin.locator("#ayuntamiento").getByLabel("Municipio").fill("San Román de los Montes");
    await admin.locator("#ayuntamiento").getByLabel("Provincia").fill("Toledo");
    await admin.locator("#ayuntamiento").getByRole("button", { name: "Guardar ayuntamiento" }).click();
    await expect(admin.locator(".brand small")).toHaveText("San Román de los Montes");
    const reset = admin.getByRole("button", { name: "Restaurar el escudo por defecto" });
    if (await reset.count()) {
      await reset.click();
      await expect(admin.locator("#ayuntamiento")).toContainText("Escudo (por defecto)");
    }
  }
});

test("accesibilidad (axe-core WCAG 2.1 AA) en las pantallas principales, claro y oscuro", async ({ browser }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  for (const colorScheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme });
    const page = await ctx.newPage();
    const check = async (url: string) => {
      await page.goto(url);
      if (url.startsWith("/colonia/solicitud")) await expect(page.locator("form.solicitud")).toBeVisible(); // isla client:only
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${url} [${colorScheme}]: ${v.id} (${v.nodes.length})`)).toEqual([]);
    };
    await check("/");
    await check("/login");
    await check("/accesibilidad");
    await login(page, ADMIN);
    const temario = await activeTemario(ctx);
    await check("/documentos");
    await check("/privacidad");
    for (const url of ["/", "/carnet", "/colonia", "/colonia/solicitud", "/colonia/solicitud?anexo=ii", "/colonia/solicitud?anexo=aut", "/temario", `/temario/${temario.slugs[2]}`, "/perfil", "/admin", "/admin/temarios", `/admin/temarios/${temario.id}`, "/admin/preguntas", "/admin/ajustes", "/admin/programa", "/admin/textos", "/admin/textos/mi-colonia", "/temario/local"]) await check(url);
    await ctx.close();
  }
});

test("declaración de accesibilidad y comunicaciones", async ({ browser }) => {
  // Sin sesión: la declaración es pública, enlazada desde el pie, y el formulario envía la comunicación.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.locator("footer").getByRole("link", { name: "Accesibilidad" }).click();
  await expect(page).toHaveURL(/\/accesibilidad\?desde=%2Flogin/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Declaración de accesibilidad");
  for (const h of ["Situación de cumplimiento", "Contenido no accesible", "Preparación de la presente declaración de accesibilidad", "Observaciones y datos de contacto", "Procedimiento de aplicación"]) {
    await expect(page.getByRole("heading", { name: h })).toBeVisible();
  }
  await expect(page.getByLabel("Página o pantalla afectada (opcional)")).toHaveValue("/login");
  const texto = `Prueba E2E ${Date.now()}: el botón no se lee bien con el lector de pantalla.`;
  await page.getByLabel("Describe el problema o la consulta").fill(texto);
  await page.getByLabel("Correo electrónico (opcional, para poder responderte)").fill("vecina@example.org");
  await page.getByRole("button", { name: "Enviar comunicación" }).click();
  await expect(page.getByText("Hemos recibido tu comunicación")).toBeVisible();

  // El admin la ve en el panel y la marca como resuelta.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin");
  await expect(admin.getByText(/de accesibilidad sin resolver/)).toBeVisible();
  await admin.goto("/admin/accesibilidad");
  const card = admin.locator("article.card", { hasText: texto });
  await expect(card).toContainText("Nueva");
  await card.getByLabel("Estado").selectOption("resuelta");
  await card.getByLabel("Notas internas / respuesta enviada").fill("Respondido por correo.");
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(admin.locator("article.card", { hasText: texto })).toContainText("Resuelta");
});

test("Mi colonia y documentos del Ayuntamiento", async ({ browser }) => {
  // Documentos: públicos, agrupados, con las ordenanzas municipales y enlaces externos seguros.
  const pub = await (await browser.newContext()).newPage();
  await pub.goto("/documentos");
  await expect(pub.getByRole("heading", { name: "Ordenanzas" })).toBeVisible();
  const ord = pub.locator("a.doc-item", { hasText: "colonias felinas urbanas" });
  await expect(ord).toHaveAttribute("target", "_blank");
  await expect(ord).toHaveAttribute("rel", /noopener/);
  await expect(ord).toHaveAttribute("href", /bop\.diputoledo\.es/);

  // Alumno sin carnet: la guía se ofrece desde el inicio y el primer paso no está completado.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, `colonia-${Date.now()}@example.org`);
  await page.getByRole("link", { name: /Después: Mi colonia/ }).click();
  await expect(page).toHaveURL(/\/colonia$/);
  await expect(page.locator(".colonia-step")).toHaveCount(6);
  await expect(page.locator(".colonia-step").first()).not.toHaveClass(/done/);
  await expect(page.getByText("no se registran colonias en viviendas particulares")).toBeVisible();

  // Anexo I: formulario en blanco descargable y relleno en el dispositivo, sin enviar datos al servidor.
  const blanco = await page.request.get("/docs/anexo-i-solicitud-registro-colonia.pdf");
  expect(blanco.ok()).toBeTruthy();
  expect(blanco.headers()["content-type"]).toContain("application/pdf");
  await page.getByRole("link", { name: "Rellenar el Anexo I", exact: true }).click();
  await expect(page).toHaveURL(/\/colonia\/solicitud$/);
  const form = page.locator("form.solicitud");
  await form.getByLabel("NIF").first().fill("12345678Z");
  await form.getByLabel("Dirección exacta").fill("Calle Real, 1 (solar municipal)");
  await form.getByLabel("Público", { exact: true }).check();
  await form.getByLabel("Hembras sin esterilizar").fill("3");
  await form.getByRole("button", { name: "Añadir otra persona cuidadora" }).click();
  await expect(form.getByRole("group", { name: "Persona cuidadora 2" })).toBeVisible();
  const posts: string[] = [];
  page.on("request", (r) => r.method() !== "GET" && posts.push(r.url()));
  const [descarga] = await Promise.all([page.waitForEvent("download"), form.getByRole("button", { name: "Descargar el PDF relleno" }).click()]);
  expect(descarga.suggestedFilename()).toBe("anexo-i-solicitud-registro-colonia.pdf");
  await expect(form.getByRole("status").last()).toContainText("PDF generado");
  expect(posts).toEqual([]);
  // Solar privado: el Anexo I sale con la autorización de la persona propietaria en el mismo PDF.
  await form.getByLabel(/^Privado/).check();
  await expect(form.getByText("autorización expresa de la persona propietaria")).toBeVisible();
  const [conAut] = await Promise.all([page.waitForEvent("download"), form.getByRole("button", { name: "Descargar el PDF relleno" }).click()]);
  expect(conAut.suggestedFilename()).toBe("anexo-i-y-autorizacion-propietario.pdf");
  expect((await page.request.get("/docs/autorizacion-propietario-terreno.pdf")).ok()).toBeTruthy();
  await page.getByRole("link", { name: "Autorización de la persona propietaria" }).first().click();
  await expect(page).toHaveURL(/anexo=aut/);
  await page.locator("form.solicitud").getByLabel("Referencia catastral (opcional)").fill("1234567VK1234N0001AB");
  const [soloAut] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar el PDF relleno" }).click()]);
  expect(soloAut.suggestedFilename()).toBe("autorizacion-propietario-terreno.pdf");
  expect(posts).toEqual([]);
  await page.getByRole("link", { name: /Anexo II/ }).click();
  await expect(page.locator("form.solicitud")).not.toContainText("Datos de la colonia");
  await page.goto("/colonia");

  // Admin: añade un documento, aparece publicado y se elimina; edita y restaura la guía.
  const admin = await (await browser.newContext()).newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/documentos/nuevo");
  const titulo = `Formulario de prueba E2E ${Date.now()}`;
  await admin.getByLabel("Título").fill(titulo);
  await admin.getByLabel("Categoría", { exact: true }).selectOption("formulario");
  await admin.getByLabel("Enlace").fill("javascript:alert(1)");
  await admin.getByRole("button", { name: "Guardar documento" }).click();
  await expect(admin.locator(".alert.bad")).toContainText("https://");
  await admin.getByLabel("Enlace").fill("https://sanromandelosmontes.sedelectronica.es/dossier");
  await admin.getByRole("button", { name: "Guardar documento" }).click();
  await expect(admin.getByText("Documento guardado.")).toBeVisible();
  await pub.goto("/documentos");
  await expect(pub.getByRole("heading", { name: "Formularios y solicitudes" })).toBeVisible();
  await expect(pub.locator("a.doc-item", { hasText: titulo })).toBeVisible();
  admin.on("dialog", (d) => d.accept());
  await admin.goto("/admin/documentos");
  await admin.getByRole("button", { name: `Eliminar ${titulo}` }).click();
  await expect(admin.getByText("Documento eliminado.")).toBeVisible();

  // La antigua dirección del editor lleva a Textos. Se edita la guía y se vuelve a dejar la que había
  // (la precargada del municipio, no la genérica por defecto).
  await admin.goto("/admin/colonia");
  await expect(admin).toHaveURL(/\/admin\/textos\/mi-colonia$/);
  const guia = admin.getByLabel("Contenido (Markdown)");
  const original = await guia.inputValue();
  await guia.fill("Introducción de prueba en {{municipio}}.\n\n## Primer paso de prueba\nTexto.\n\n## Segundo paso\nMás texto.");
  await admin.getByRole("button", { name: "Guardar texto" }).click();
  await expect(admin.getByText("Texto guardado.")).toBeVisible();
  await page.goto("/colonia");
  await expect(page.locator(".colonia-step")).toHaveCount(2);
  await expect(page.locator(".colonia-intro")).not.toContainText("{{");
  await admin.getByLabel("Contenido (Markdown)").fill(original);
  await admin.getByRole("button", { name: "Guardar texto" }).click();
  await expect(admin.getByText("Texto guardado.")).toBeVisible();
  await page.goto("/colonia");
  await expect(page.locator(".colonia-step")).toHaveCount(6);

  // Programa local: un valor no válido no se guarda y se señala en su campo.
  await admin.goto("/admin/programa");
  await admin.getByLabel("Enlace al trámite de la sede electrónica").fill("http://inseguro.example");
  await admin.getByRole("button", { name: "Guardar programa local" }).click();
  await expect(admin.locator(".alert.bad")).toContainText("No se ha guardado");
  await expect(admin.getByLabel("Enlace al trámite de la sede electrónica")).toHaveAttribute("aria-invalid", "true");
});

/** Da a un usuario un carnet vigente directamente en la base local (para no repetir todo el curso). */
function darCarnet(email: string, nombre: string, apellidos: string) {
  const sql = `UPDATE users SET nombre='${nombre}', apellidos='${apellidos}', consent_at=unixepoch()*1000 WHERE email='${email}';
INSERT INTO carnets (id, numero, user_id, nombre, apellidos, issued_at, expires_at) SELECT lower(hex(randomblob(16))), 'E2E-' || lower(hex(randomblob(4))), id, nombre, apellidos, unixepoch()*1000, unixepoch('now','+1 year')*1000 FROM users WHERE email='${email}';`;
  execSync(`npx wrangler d1 execute colonias --local --command "${sql.replace(/\n/g, " ")}"`, { stdio: "ignore" });
}

test("alta de colonia, censo, fichas, carnet y baja validada con JEV", async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const email = `cuidadora-${stamp}@example.org`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, email);
  darCarnet(email, "Rosa", `Prueba ${stamp}`);

  // El ayuntamiento registra la colonia con la persona como responsable.
  const admin = await (await browser.newContext()).newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/colonias/nueva");
  const nombreColonia = `Colonia E2E ${stamp}`;
  await admin.getByLabel("Nombre de la colonia").fill(nombreColonia);
  await admin.getByLabel("Dirección exacta").fill("Calle de las Pruebas, 1");
  const opt = admin.locator("#responsable option", { hasText: `Rosa Prueba ${stamp}` });
  await admin.getByLabel("Persona cuidadora responsable").selectOption((await opt.getAttribute("value"))!);
  await admin.getByLabel("Hembras esterilizadas").fill("3");
  await admin.getByLabel("Hembras sin esterilizar").fill("2");
  await admin.getByLabel("Machos castrados").fill("1");
  await admin.getByLabel("Machos sin castrar").fill("1");
  await admin.getByRole("button", { name: "Registrar colonia" }).click();
  await expect(admin.getByText(/Colonia n\.º \d+ registrada/)).toBeVisible();

  // Aparece en su carnet: solo nombre y gatos declarados. Y un aviso de que la colonia está registrada.
  await page.goto("/");
  await expect(page.locator(".carnet.front .carnet-colonias")).toContainText(`${nombreColonia} · 7 gatos`);
  const aviso = page.locator(".notice", { hasText: "Tu colonia ya está registrada" });
  await expect(aviso).toContainText(nombreColonia);
  await expect(aviso).toContainText("persona cuidadora responsable");

  // «Ver la colonia» lleva a su gestión; el aviso se muestra por última vez y queda leído.
  await aviso.getByRole("link", { name: "Ver la colonia" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(nombreColonia);
  await expect(page.locator(".notice")).toContainText("Tu colonia ya está registrada");
  await page.goto("/");
  await expect(page.locator(".notice")).toHaveCount(0);

  // «Mi colonia» pasa a ser la gestión de la colonia.
  await page.getByRole("link", { name: "Colonia", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(nombreColonia);
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const axe = async () => {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => `${page.url()}: ${v.id}`)).toEqual([]);
  };
  await axe();
  await page.getByRole("link", { name: "Añadir ficha de un gato" }).click();
  await page.getByLabel("Nombre o apodo").fill("Misi");
  await page.getByLabel("Sexo").selectOption("hembra");
  await page.getByRole("button", { name: "Guardar ficha" }).click();
  await expect(page.getByText("Ficha guardada.")).toBeVisible();
  await page.getByRole("link", { name: /Misi/ }).click();
  await page.locator("summary", { hasText: "Añadir intervención" }).click();
  await page.getByLabel("Motivo").selectOption("esterilizacion");
  await page.getByLabel("Clínica veterinaria").fill("Clínica de prueba");
  await page.getByRole("button", { name: "Añadir intervención" }).click();
  await expect(page.getByText("Intervención añadida.")).toBeVisible();
  await expect(page.getByLabel("Esterilizado")).toBeChecked();
  // Un gato que tenía dueño y vuelve con él sale de la colonia como «devuelto».
  await page.goto("/colonia");
  await page.getByRole("link", { name: "Añadir ficha de un gato" }).click();
  await page.getByLabel("Nombre o apodo").fill("Tom");
  await page.getByLabel("Sexo").selectOption("macho");
  await page.getByLabel("Situación").selectOption("devuelto");
  await page.getByRole("button", { name: "Guardar ficha" }).click();
  await expect(page.locator(".cat-item", { hasText: "Tom" })).toContainText("Devuelto a su responsable legal");

  // Nuevo censo: el carnet refleja el nuevo total.
  await page.goto("/colonia");
  await page.getByRole("link", { name: "Actualizar el censo" }).click();
  await axe();
  await page.getByLabel("Hembras esterilizadas").fill("5");
  // Movimientos desde el censo anterior (obligatorios en la precarga de San Román): si no cuadran, aviso y
  // «Guardar igualmente»; no se bloquea.
  const movimientos = page.locator(".censo-movimientos input");
  const conMovimientos = (await movimientos.count()) > 0;
  if (conMovimientos) {
    for (const inp of await movimientos.all()) await inp.fill("0");
    await page.getByRole("button", { name: "Guardar censo" }).click();
    await expect(page.locator("#censo-aviso")).toContainText("Las hembras no cuadran");
    await axe();
    await page.locator("#nacidosHembras").fill("1");
    await page.getByRole("button", { name: "Guardar igualmente" }).click();
  } else {
    await page.getByRole("button", { name: "Guardar censo" }).click();
  }
  await expect(page.getByText("Tu carnet ya muestra 9 gatos.")).toBeVisible();
  if (conMovimientos) {
    await page.getByRole("link", { name: "Actualizar el censo" }).click();
    await page.locator("summary", { hasText: "Ver movimientos" }).first().click();
    await expect(page.locator(".census-moves").first()).toContainText("Nacidos en la colonia");
  }
  // Cada censo del historial se descarga en PDF (por si el ayuntamiento lo pide en papel); sin sesión, no.
  await page.goto("/colonia");
  await page.getByRole("link", { name: "Actualizar el censo" }).click();
  const [descarga] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /Descargar el censo en PDF/ }).first().click()]);
  expect(descarga.suggestedFilename()).toMatch(/censo-colonia-\d+-\d{4}-\d{2}-\d{2}\.pdf$/);
  const pdfPath = new URL(descarga.url()).pathname;
  expect((await admin.request.get(pdfPath)).headers()["content-type"]).toBe("application/pdf");
  const anonimo = await (await browser.newContext()).request.get(pdfPath, { maxRedirects: 0 });
  expect(anonimo.status()).toBeGreaterThanOrEqual(300);
  expect(anonimo.headers()["content-type"] ?? "").not.toContain("pdf");
  await page.goto("/carnet");
  await expect(page.locator(".carnet.front .carnet-colonias")).toContainText(`${nombreColonia} · 9 gatos`);

  // Baja: explicación vaga → botón deshabilitado con el motivo; motivo + relevo → habilitado.
  await page.goto("/colonia");
  await page.getByRole("link", { name: "Dejar de colaborar en esta colonia" }).click();
  await axe();
  const texto = page.getByLabel("¿Por qué dejas de colaborar en esta colonia?");
  const boton = page.getByRole("button", { name: "Dejar de colaborar en esta colonia" });
  await texto.fill("No puedo seguir por motivos personales, lo siento mucho de verdad.");
  await expect(page.locator("#baja-status")).toContainText("revisa lo que falta", { timeout: 30_000 });
  await expect(boton).toBeDisabled();
  await expect(page.locator(".baja-checks")).toContainText("quién se hará cargo");
  await texto.fill("Me mudo a Talavera en octubre por un cambio de trabajo y no podré venir cada día. Mi vecina Carmen López, que ya me ayudaba, se hará cargo de la colonia.");
  await expect(page.locator("#baja-status")).toContainText("Ya puedes comunicar la baja", { timeout: 30_000 });
  await expect(boton).toBeEnabled();
  await boton.click();
  await page.getByRole("button", { name: "Confirmar la baja" }).click();
  await expect(page).toHaveURL(/\/colonia\?baja=1/);
  await expect(page.getByText("Has dejado de colaborar en la colonia")).toBeVisible();
  await page.goto("/carnet");
  await expect(page.locator(".carnet-colonias")).toHaveCount(0);

  // El ayuntamiento ve la colonia sin cuidadores y la explicación con su valoración.
  await admin.goto("/admin/colonias");
  await expect(admin.getByText(/sin personas cuidadoras/)).toBeVisible();
  await expect(admin.locator("article", { hasText: nombreColonia })).toContainText("Valoración JEV");
  // Limpieza: se da de baja la colonia de prueba.
  await admin.locator("tr", { hasText: nombreColonia }).getByRole("link", { name: /Gestionar colonia/ }).click();
  await admin.getByLabel(/Dar de baja la colonia/).check();
  await admin.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(admin.getByText("Datos guardados.")).toBeVisible();
});

test("carnet sin caducidad: ajuste vacío, renovación y aplicar la vigencia a los vigentes", async ({ browser }) => {
  const stamp = Date.now();
  const email = `vigencia-${stamp}@example.org`;
  const page = await (await browser.newContext()).newPage();
  await login(page, email);
  darCarnet(email, "Vera", `Vigencia ${stamp}`);
  await page.goto("/carnet");
  await expect(page.locator(".carnet.front .c-fields")).toContainText("Válido hasta");

  const admin = await (await browser.newContext()).newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/ajustes");
  const original = await admin.getByLabel(/Validez del carnet/).inputValue();
  await admin.getByLabel(/Validez del carnet/).fill("");
  await admin.getByRole("button", { name: "Guardar ajustes" }).click();
  await expect(admin.getByText("Ajustes guardados")).toBeVisible();
  try {
    await expect(admin.getByLabel(/Validez del carnet/)).toHaveValue("");
    // Aplicar a los vigentes pide confirmación en la propia página (aquí se cancela para no cambiar
    // todos los carnets de la base local).
    await admin.goto("/admin/carnets");
    await admin.getByRole("button", { name: "Aplicar esta vigencia a los carnets vigentes" }).click();
    await expect(admin.locator("#vigencia-confirmar")).toContainText(/no caducar/);
    await admin.locator("#vigencia-confirmar").getByRole("link", { name: "Cancelar" }).click();
    await expect(admin.locator("#vigencia-confirmar")).toHaveCount(0);
    // Con vigencia indefinida, renovar deja el carnet sin caducidad (igual que un carnet nuevo).
    const fila = () => admin.locator("tr", { hasText: `Vigencia ${stamp}` });
    await fila().getByRole("button", { name: "Renovar" }).click();
    await expect(fila()).toContainText("Sin caducidad");
    await expect(fila().getByRole("button", { name: "Renovar" })).toHaveCount(0);
    await page.goto("/carnet");
    await expect(page.locator(".carnet.front .c-fields")).toContainText("Sin caducidad");
    await expect(page.locator(".front .c-live")).toContainText("Vigente");
  } finally {
    await admin.goto("/admin/ajustes");
    await admin.getByLabel(/Validez del carnet/).fill(original);
    await admin.getByRole("button", { name: "Guardar ajustes" }).click();
  }
});

test("fotos y observaciones de los gatos, y relevo automático de la persona responsable", async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const mk = async (tag: string, nombre: string) => {
    const email = `${tag}-${stamp}@example.org`;
    const page = await (await browser.newContext()).newPage();
    await login(page, email);
    darCarnet(email, nombre, `Foto ${stamp}`);
    return page;
  };
  const rosa = await mk("rosa", "Rosa");
  const luis = await mk("luis", "Luis");
  const extraña = await (await browser.newContext()).newPage();
  await login(extraña, `sin-colonia-${stamp}@example.org`);

  // Colonia con Rosa responsable y Luis colaborador.
  const admin = await (await browser.newContext()).newPage();
  await login(admin, ADMIN);
  await admin.goto("/admin/colonias/nueva");
  const nombreColonia = `Colonia fotos ${stamp}`;
  await admin.getByLabel("Nombre de la colonia").fill(nombreColonia);
  await admin.getByLabel("Dirección exacta").fill("Plaza de las Pruebas, 2");
  const optRosa = admin.locator("#responsable option", { hasText: `Rosa Foto ${stamp}` });
  await admin.getByLabel("Persona cuidadora responsable").selectOption((await optRosa.getAttribute("value"))!);
  await admin.locator("label.check", { hasText: `Luis Foto ${stamp}` }).locator("input").check();
  await admin.getByLabel("Hembras esterilizadas").fill("2");
  await admin.getByRole("button", { name: "Registrar colonia" }).click();
  await expect(admin.getByText(/Colonia n\.º \d+ registrada/)).toBeVisible();

  // Ficha con foto principal y una observación con dos fotos.
  await rosa.goto("/colonia");
  await rosa.getByRole("link", { name: "Añadir ficha de un gato" }).click();
  await rosa.getByLabel("Nombre o apodo").fill("Tigre");
  await rosa.getByRole("button", { name: "Guardar ficha" }).click();
  await rosa.getByRole("link", { name: /Tigre/ }).click();
  await rosa.getByLabel("Añadir una foto").setInputFiles("public/img/hero.jpg");
  await rosa.getByRole("button", { name: "Guardar foto" }).click();
  await expect(rosa.getByText("Foto guardada.")).toBeVisible();
  const foto = rosa.locator("img.cat-photo");
  await expect(foto).toHaveAttribute("alt", /Foto de Tigre/);
  const src = (await foto.getAttribute("src"))!;
  const res = await rosa.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/jpeg");
  expect(res.headers()["cache-control"]).toContain("private");

  await rosa.getByLabel("Nueva observación").fill("Cojea un poco de la pata trasera izquierda. Come bien.");
  await rosa.getByLabel(/^Fotos/).setInputFiles(["public/img/portada-640.jpg", "public/img/curso/gatos-comunitarios/gato-calle-pueblo.jpg"]);
  await expect(rosa.locator("#fotos-status")).toContainText("2 fotos listas");
  await rosa.getByRole("button", { name: "Añadir observación" }).click();
  await expect(rosa.getByText("Observación añadida.")).toBeVisible();
  await expect(rosa.locator(".notes li").first()).toContainText("Cojea un poco");
  await expect(rosa.locator(".notes li").first().locator(".note-photos img")).toHaveCount(2);

  // Una persona que no cuida la colonia no puede ver las fotos.
  expect((await extraña.request.get(src)).status()).toBe(403);
  // Luis, colaborador de la misma colonia, sí.
  expect((await luis.request.get(src)).status()).toBe(200);

  // Al borrar la observación y quitar la foto, los ficheros desaparecen de R2.
  const notaFotos = await rosa.locator(".notes li").first().locator(".note-photos img").evaluateAll((els) => els.map((e) => e.getAttribute("src")!));
  rosa.on("dialog", (d) => d.accept());
  await rosa.locator(".notes li").first().getByRole("button", { name: /Borrar la observación/ }).click();
  await expect(rosa.getByText("Observación eliminada.")).toBeVisible();
  for (const f of notaFotos) expect((await rosa.request.get(f)).status()).toBe(404);
  await rosa.getByRole("button", { name: "Quitar la foto" }).click();
  await expect(rosa.getByText("Foto eliminada.")).toBeVisible();
  expect((await rosa.request.get(src)).status()).toBe(404);

  // Rosa se va: no se le pide relevo (queda Luis) y se le avisa de que Luis será responsable.
  await rosa.goto("/colonia");
  await rosa.getByRole("link", { name: "Dejar de colaborar en esta colonia" }).click();
  await expect(rosa.locator("#baja-sucesor")).toContainText(`Luis Foto ${stamp}`);
  await rosa.getByLabel("¿Por qué dejas de colaborar en esta colonia?").fill("Me mudo a Madrid el mes que viene por un cambio de trabajo y no podré seguir viniendo a la colonia.");
  const boton = rosa.getByRole("button", { name: "Dejar de colaborar en esta colonia" });
  await expect(boton).toBeEnabled({ timeout: 30_000 });
  await boton.click();
  await rosa.getByRole("button", { name: "Confirmar la baja" }).click();
  await expect(rosa).toHaveURL(/\/colonia\?baja=1/);

  // Luis pasa a ser la persona responsable y el ayuntamiento lo ve.
  await luis.goto("/colonia");
  await expect(luis.getByText("Eres la persona cuidadora responsable.")).toBeVisible();
  await admin.goto("/admin/colonias");
  await expect(admin.locator("article", { hasText: nombreColonia })).toContainText(`Nueva persona responsable: Luis Foto ${stamp}`);
  // Limpieza.
  await admin.locator("tr", { hasText: nombreColonia }).getByRole("link", { name: /Gestionar colonia/ }).click();
  await admin.getByLabel(/Dar de baja la colonia/).check();
  await admin.getByRole("button", { name: "Guardar", exact: true }).click();
});

test("temarios: activar otro, progreso separado, volver, preguntas en un temario no activo e importar un paquete", async ({ browser }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const axe = async (p: Page) => {
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => `${p.url()}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  };
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, ADMIN);
  const original = await activeTemario(adminCtx);
  // El otro temario del seed (el propio si el activo es el de Toledo, y al revés).
  const otro = original.id === "propio" ? "toledo-2025" : "propio";

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, `e2e-temarios-${Date.now()}@example.org`);

  /** Aprueba el primer tema del temario activo con su banco de preguntas. */
  const aprobarPrimero = async (slug: string) => {
    const bank = await exportBank(adminCtx);
    await page.goto(`/temario/${slug}/test`);
    await page.getByRole("button", { name: "Empezar el test" }).click();
    await answerAll(page, bank, true);
    await page.getByRole("button", { name: "Enviar respuestas" }).click();
    await expect(page.getByText("Aprobado", { exact: true })).toBeVisible();
  };
  const temasEnInicio = page.locator("ol.path > li:not(.final):not(.extra)");

  try {
    // Lista de temarios (con axe) y progreso en el temario original.
    await admin.goto("/admin/temarios");
    await expect(admin.getByRole("row", { name: /^Temario propio de colonias felinas/ })).toBeVisible();
    await axe(admin);
    await aprobarPrimero(original.slugs[0]);
    await page.goto("/");
    await expect(temasEnInicio).toHaveCount(original.slugs.length);
    await expect(temasEnInicio.first()).toHaveClass(/done/);

    // Página de impacto: avisa de quien tiene progreso sin carnet y pide confirmación en la propia página.
    await admin.goto(`/admin/temarios/${otro}/activar`);
    await expect(admin.getByRole("heading", { name: "Qué va a pasar" })).toBeVisible();
    await expect(admin.getByText(/sin carnet tienen? temas aprobados del temario actual/)).toBeVisible();
    await axe(admin);
    await admin.getByRole("button", { name: "Activar el temario" }).click();
    await expect(admin).toHaveURL(new RegExp(`/admin/temarios/${otro}/activar`)); // sin marcar la casilla no se activa
    await activar(admin, otro);
    const nuevo = await activeTemario(adminCtx);
    expect(nuevo.id).toBe(otro);

    // La persona empieza el nuevo temario desde el principio; el test sale de su banco.
    await page.goto("/");
    await expect(temasEnInicio).toHaveCount(nuevo.slugs.length);
    await expect(temasEnInicio.first()).toHaveClass(/current/);
    await expect(temasEnInicio.nth(1)).toHaveClass(/locked/);
    expect((await page.goto(`/temario/${original.slugs.find((s) => !nuevo.slugs.includes(s))}`))!.status()).toBe(404);
    await aprobarPrimero(nuevo.slugs[0]);
    await page.goto("/");
    await expect(temasEnInicio.first()).toHaveClass(/done/);
    await expect(temasEnInicio.nth(1)).toHaveClass(/current/);
    await page.goto("/examen");
    await expect(page.getByText("Aprueba todos los temas")).toBeVisible();

    // Con todos los temas del nuevo temario aprobados, el examen final sale solo de su banco.
    const bankNuevo = await exportBank(adminCtx);
    for (const slug of nuevo.slugs.slice(1)) {
      await page.goto(`/temario/${slug}/test`);
      await page.getByRole("button", { name: "Empezar el test" }).click();
      await answerAll(page, bankNuevo, true);
      await page.getByRole("button", { name: "Enviar respuestas" }).click();
      await expect(page.getByText("Aprobado", { exact: true })).toBeVisible();
    }
    await page.goto("/perfil");
    await page.getByLabel("Nombre").fill("Tema");
    await page.getByLabel("Apellidos").fill("Rio Prueba");
    await page.locator('input[name="consent"]').check();
    await page.getByRole("button", { name: "Guardar" }).click();
    await page.goto("/examen");
    await page.getByRole("button", { name: "Empezar el examen final" }).click();
    await answerAll(page, bankNuevo, true); // falla si alguna pregunta no es del banco del nuevo temario

    // Volver al temario original recupera el progreso que se tenía.
    await activar(admin, original.id);
    await page.goto("/");
    await expect(temasEnInicio).toHaveCount(original.slugs.length);
    await expect(temasEnInicio.first()).toHaveClass(/done/);
  } finally {
    await activar(admin, original.id);
  }

  // Preguntas en un temario no activo: se crean en su tema (aunque otro temario repita el slug) sin tocar el activo.
  await admin.goto(`/admin/preguntas?temario=${otro}`);
  await expect(admin.getByText("no está activo")).toBeVisible();
  await admin.getByRole("link", { name: "Nueva pregunta" }).click();
  const enunciado = `¿Pregunta E2E del temario ${otro} ${Date.now()}?`;
  const temaCer = admin.locator("#tema option", { hasText: "método CER" });
  await admin.getByLabel("Tema", { exact: true }).selectOption((await temaCer.getAttribute("value"))!);
  await admin.getByLabel("Enunciado", { exact: true }).fill(enunciado);
  await admin.getByLabel("Opciones (una por línea)").fill("Sí\nNo");
  await admin.getByLabel("Número de la opción correcta").fill("1");
  await admin.locator('#qform input[name="activo"]').uncheck();
  await admin.getByRole("button", { name: "Guardar" }).click();
  await expect(admin.getByText("Guardada.")).toBeVisible();
  await expect(admin.getByText(/Temario: .*\(no activo\)/)).toBeVisible();
  const enOtro = await exportBank(adminCtx, otro);
  expect(enOtro.has(enunciado)).toBe(true);
  expect((await exportBank(adminCtx)).has(enunciado)).toBe(false);
  // Al volver a guardarla sigue en su temario.
  await admin.getByRole("button", { name: "Guardar" }).click();
  await expect(admin.getByText("Guardada.")).toBeVisible();
  expect((await exportBank(adminCtx, otro)).has(enunciado)).toBe(true);

  // Exportar e importar un paquete: dos temas cuyos slugs ya existen en otros temarios.
  const paquete = await (await adminCtx.request.get(`/api/admin/temarios/propio/export`)).json();
  const id = `e2e-${Date.now()}`;
  const temas = paquete.temas.filter((t: { slug: string }) => ["metodo-cer", "programa-municipal"].includes(t.slug));
  const pequeño = {
    ...paquete,
    temario: { ...paquete.temario, id, nombre: `Temario E2E ${id}` },
    temas,
    preguntas: paquete.preguntas.filter((q: { tema: string }) => ["metodo-cer", "programa-municipal"].includes(q.tema)).slice(0, 6),
  };
  const subir = async (json: unknown) => {
    await admin.goto("/admin/temarios");
    await admin.getByLabel("Paquete del temario (JSON)").setInputFiles({ name: "temario.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) });
    await admin.getByRole("button", { name: "Importar temario" }).click();
  };
  await subir(pequeño);
  await expect(admin.getByText(`Temario «${id}» importado: 2 temas y 6 preguntas.`)).toBeVisible();
  // Mismo id: error claro y nada importado. Paquete con una pregunta mal: todo o nada.
  await subir(pequeño);
  await expect(admin.getByText(/Ya existe un temario con el identificador/)).toBeVisible();
  await subir({ ...pequeño, temario: { ...pequeño.temario, id: `${id}-b` }, preguntas: [...pequeño.preguntas, { tema: "no-existe", tipo: "mc", enunciado: "¿Tema inexistente?", opciones: ["a", "b"], correcta: 0 }] });
  await expect(admin.getByText(/tema desconocido no-existe/)).toBeVisible();
  expect((await adminCtx.request.get(`/api/admin/temarios/${id}-b/export`)).status()).toBe(404);
  const importado = await (await adminCtx.request.get(`/api/admin/temarios/${id}/export`)).json();
  expect(importado.temas.map((t: { slug: string }) => t.slug)).toEqual(temas.map((t: { slug: string }) => t.slug));
  expect(importado.preguntas).toHaveLength(6);
  // Se oculta para no dejarlo en los selectores (los temarios no se borran).
  await admin.goto(`/admin/temarios/${id}`);
  await admin.getByRole("button", { name: "Ocultar el temario" }).click();
  await expect(admin.getByText("Temario ocultado.")).toBeVisible();
  expect((await activeTemario(adminCtx)).id).toBe(original.id);
});
