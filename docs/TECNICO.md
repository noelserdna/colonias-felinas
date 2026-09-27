# Documentación técnica

Referencia para desarrolladores. La guía de instalación paso a paso está en el [README](../README.md) y las
instrucciones para asistentes de IA en [AGENTS.md](../AGENTS.md).

## Arquitectura

| Pieza | Tecnología | Dónde |
|---|---|---|
| Web y API | Astro 7 (SSR) en **Cloudflare Workers**, entrada propia con `fetch` + `scheduled` | `src/worker.ts`, `src/pages/` |
| Interactividad | Islas **React** (test y examen, formularios de anexos, baja) | `src/components/*.tsx` |
| Base de datos | **Cloudflare D1** (SQLite) con **Drizzle ORM**; migraciones SQL | `src/lib/db/schema.ts`, `migrations/` |
| Fotos | **Cloudflare R2** (bucket privado; la app comprueba permisos al servirlas) | `src/lib/photos.ts` |
| Corrección con IA | **JEV** de TypeSafe (`jev-latest`): respuestas escritas y explicación de las bajas | `src/lib/jev.ts`, `grading.ts`, `baja.ts` |
| Correo | **Cloudflare Email Service** (o Resend) | `src/lib/email.ts` |
| Avisos | En la app + correo + **Web Push** (WebCrypto, sin dependencias) | `src/lib/notices.ts`, `push.ts`, `webpush.ts` |
| PDF | **pdf-lib**: rellenos en el navegador, en blanco en el servidor (`/docs/*.pdf`) | `src/lib/anexos-pdf.ts`, `src/pages/docs/[archivo].ts` |
| PWA | Manifest dinámico y service worker propio | `src/pages/manifest.webmanifest.ts`, `public/sw.js` |
| Acceso | Enlace mágico por correo (sin contraseñas), sesiones en D1, límite de peticiones | `src/lib/auth.ts`, `src/middleware.ts` |

Variables (`wrangler.jsonc` → `vars`): `APP_NAME`, `MAIL_FROM`, `APP_ORIGIN`, `VAPID_PUBLIC_KEY`, `JEV_MOCK`, `MAIL_MOCK`
(y `DEMO` en la instancia de demostración). Secretos (`wrangler secret put`): `ADMIN_EMAILS`, `APP_SECRET`,
`VAPID_PRIVATE_KEY` y, opcionales, `TYPESAFE_API_KEY` y `RESEND_API_KEY`.

## Programa local (lo que depende de la ordenanza de cada municipio)

El código no lleva ninguna ordenanza fijada: los valores por defecto son neutros y cada municipio los configura en el
panel. San Román (ordenanza del BOP de Toledo n.º 122, de 28/06/2024) es una **precarga** más.

- **`programa`** (clave de `settings`; *Administración → Programa local*): `src/lib/programa-config.ts` (puro: esquema
  zod, `DEFAULT_PROGRAMA`, etiquetas y grupos del formulario, `renderTemplate`, `programaVars`, `textosAnexos`,
  `docsPdf`, `periodoTexto`) y `src/lib/programa.ts` (lectura y guardado; `getIdentidad` lee branding y programa en un
  solo viaje y el middleware los deja en `Astro.locals.branding` / `Astro.locals.programa`). Lectura tolerante campo
  a campo (un campo inválido toma su valor por defecto); validación estricta al guardar, con los textos de los PDF
  limitados a WinAnsi (`src/lib/winansi.ts`). Incluye: plan, órgano, normativa (nombre, forma breve, cita, enlace),
  sede electrónica, nombres oficiales de los formularios (`etiqueta_*`: «Anexo I»…; vacíos = nombre genérico), norma
  que exige la autorización en terreno privado, textos de los PDF, máximo de personas cuidadoras (1–6), censo
  (`censo_meses`, `censo_alineado` a periodos naturales, `censo_movimientos` `no|opcional|obligatorio`) y título del
  suplemento local.
- **Páginas Markdown** (`page:<slug>` en `settings`; *Administración → Textos*): `src/lib/pages-config.ts` (textos por
  defecto neutros con marcadores `{{var}}`, `{{#var}}…{{/var}}`, `{{^var}}…{{/var}}`; `splitSteps`) y `src/lib/pages.ts`.
  `mi-colonia` (guía de alta en `/colonia`), `pautas-colonia` (en cada colonia) y `programa-local` (suplemento en
  `/temario/local`, enlazado desde el inicio, la consulta, «Mi colonia» y los temas con «Pregunta en tu ayuntamiento»;
  vacío = no existe). `/admin/colonia` redirige a `/admin/textos/mi-colonia`.
- **PDF de las solicitudes** (`src/lib/anexos-pdf.ts`, puro): reciben `textos: AnexoTextos` (ver `textosAnexos`). Los
  rellenos se generan en el navegador (`SolicitudForm.tsx` recibe los textos ya resueltos); los en blanco, en el
  servidor con `src/pages/docs/[archivo].ts` (escudo propio PNG/JPG o el por defecto; un escudo WebP no se incrusta),
  con ETag. Admite `*solicitud-registro-colonia.pdf`, `*solicitud-alta-colaborador.pdf` (con o sin prefijo del
  nombre oficial, p. ej. `anexo-i-…`) y `autorizacion-propietario-terreno.pdf`. Sube `VERSION_PDF` si cambia el diseño.
- **Censo** (`src/lib/colonies.ts`): `censusDue(last, now, {meses, alineado})`, movimientos por sexo (12 columnas
  *nullable* en `colony_censuses`), `validateCensus` (un descuadre es un aviso con «Guardar igualmente», no un error),
  `censusMovementsFromCats` (propuesta a partir de las fichas, con `colony_cats.estado_desde`) y el estado de gato
  `devuelto` (a su responsable legal).
- **Ajustes**: `carnet_prefix` (por defecto `CF`), `carnet_validity_months` (0 o vacío = **indefinido**, el valor por
  defecto: el carnet vale mientras se colabora y se retira revocándolo) y `carnet_aviso_dias` (aviso de caducidad; se
  repite 15 días después; no afecta a los indefinidos).
- **Carnet sin caducidad** (`src/lib/carnet-vigencia.ts`, puro): se guarda con la fecha centinela `SIN_CADUCIDAD`
  (31/12/9999) en `carnets.expires_at`, que sigue siendo NOT NULL; así todas las consultas `expires_at > ahora` siguen
  valiendo. `esIndefinido`, `caducidad(desde, meses)` y `textoCaducidad` («Sin caducidad» en la UI). En
  *Administración → Carnets*, «Aplicar esta vigencia a los carnets vigentes» (con confirmación en la página,
  `planVigencia`) recalcula la caducidad de los no revocados y sin caducar desde su fecha de emisión.
- **Censo en PDF** (`censoPdf` en `anexos-pdf.ts`, datos con `censoPdfDatos` de `colonies.ts`):
  `/colonia/<id>/censo/<censoId>.pdf`, solo para quien cuida la colonia o el ayuntamiento (`loadColony`). Título con
  `etiqueta_censo` (p. ej. «Anexo V»), periodo desde el censo anterior, tabla por sexo con los movimientos («—» si no
  se declararon), esterilizados, adoptables, enfermos, observaciones y firma. Botón en cada fila del historial.
- **Precargas** `seed/local/<slug>/` + `node scripts/build-local.mjs <slug> [--sobrescribir]` → `seed/local/<slug>.sql`
  (ignorado por git), idempotente (`ON CONFLICT DO NOTHING`). La de San Román: `npm run db:local:sanroman:local`
  (`:remote` / `:demo` para producción y demo; orden de despliegue: migraciones → precarga → deploy). El suplemento
  local se toma de `programa-local.md` o, si no existe, de `seed/temario-propio/local/<slug>.md`.
- **Declaración de accesibilidad**: cita el `credito` del temario activo (o, si no tiene, `branding.credito_formativo`)
  como origen de las imágenes del temario.

## Temarios (varios, uno activo)

- Tabla `temarios` (`id` slug, `nombre`, `descripcion`, `credito`, `oculto`); cada tema (`units.temario_id`) pertenece
  a uno y los slugs solo son únicos **dentro** de cada temario (índice `units_temario_slug_unique`). `units.temario_id`
  no tiene `REFERENCES` (se añadió con `ALTER TABLE` sin reconstruir `units`): la integridad la garantiza la app.
- Temario activo: clave `temario_activo` de `settings`. Lectura tolerante con `elegirTemarioActivo`
  (`src/lib/temarios-config.ts`, puro): el guardado si existe, está visible y tiene temas activos; si no, `toledo-2025`;
  si no, el primero con temas. `getIdentidad` lo lee en el mismo viaje que el branding y el middleware lo deja en
  `Astro.locals.temario` (`id`, `nombre`, `credito`). El pie usa `credito` del temario activo y, si está vacío,
  `branding.credito_formativo`.
- «Temas activos» = `units.activo` **y** del temario activo (`activeUnits`, `findActiveUnitBySlug` en
  `src/lib/temarios.ts`): progreso, tests, examen final, temario, consulta, portada y demo. El progreso va por tema,
  así que cada temario conserva el suyo y volver a activarlo lo recupera. `attempts.temario_id` (finales) y
  `carnets.temario_id` guardan con qué temario se hizo el examen y se acreditó. Un final **sin enviar** de otro temario
  queda anulado (no se retoma ni se puede enviar); los que ya se estaban corrigiendo terminan igual. Los carnets no se
  tocan.
- Panel *Administración → Temarios*: lista (temas, preguntas por tipo, cobertura), activar (página de impacto,
  `impactoCambio`, con confirmación en la propia página), crear, editar nombre/descripción/crédito, ocultar (no se
  borran: FK sin cascada), exportar paquete JSON (`/api/admin/temarios/<id>/export`) e importar un paquete como temario
  nuevo (`validarPaquete`: zod, todo o nada, id existente → error; se escribe en un único `db.batch`, que en D1 es
  una transacción). El paquete lleva `formato: "temario-colonias"`, `version: 1`, `temario`, `temas` (con su Markdown)
  y `preguntas` (formato de `questions-io.ts`, `tema` = slug). Las imágenes **no** van dentro: los temas las enlazan
  por su ruta en `public/`.
- Temas y Preguntas del panel tienen un selector de temario (`?temario=…`, por defecto el activo). Las preguntas se
  resuelven siempre dentro de un temario explícito (`resolveUnit(units, temario, tema)`), nunca por el orden global.
  Un admin puede previsualizar un tema de otro temario con `/temario/<slug>?temario=<id>`.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars        # y rellena TYPESAFE_API_KEY, ADMIN_EMAILS…
npm run db:migrate:local
npm run db:seed:local                 # temarios (ver «Semilla»), preguntas y documentos
npm run dev                           # http://localhost:4321
```

Con `MAIL_MOCK=1`, el enlace de acceso se muestra en la propia página de login (solo en desarrollo).
Con `JEV_MOCK=1`, las respuestas escritas se corrigen con un simulador local, sin llamar a la API.

## Tests

```bash
npm test                                            # unitarios (selección, notas, JEV, CSV)
npx playwright test                                 # E2E: flujo completo + ajustes (usa ADMIN de .dev.vars)
node --env-file=.dev.vars scripts/calibrate-jev.ts  # calibra el umbral de JEV con el banco real
```

## Despliegue en Cloudflare

```bash
npx wrangler login
npx wrangler d1 create colonias        # copia el database_id en wrangler.jsonc
npx wrangler r2 bucket create colonias-fotos   # fotos privadas de las colonias (hay que activar R2 en la cuenta)
npm run db:migrate:remote
npm run db:seed:remote
npx wrangler secret put APP_SECRET        # cadena aleatoria larga: cifra las claves guardadas desde el panel
npx wrangler secret put TYPESAFE_API_KEY  # opcional: también se puede poner en Admin → Ajustes
npx wrangler secret put ADMIN_EMAILS      # correos de administración, separados por comas
npx wrangler secret put VAPID_PRIVATE_KEY # notificaciones push (ver «Aplicación instalable»)
npx wrangler email sending enable <dominio-del-remitente>   # correo con Cloudflare Email Service
# En wrangler.jsonc: MAIL_FROM (remitente de ese dominio), APP_ORIGIN, VAPID_PUBLIC_KEY, MAIL_MOCK="0", JEV_MOCK="0"
npm run deploy
```

Las fotos de los gatos se guardan en el bucket R2 `colonias-fotos` (privado: la app las sirve comprobando permisos).
Si hay fotos antiguas guardadas en D1 (versiones anteriores), se pasan a R2 con
`node scripts/migrate-photos-to-r2.mjs --remote` (idempotente; sin `--remote` actúa en local).

Crons: cada 5 minutos se reintenta la corrección de exámenes pendientes si JEV no respondió, y cada día a las 08:00
UTC se envían los recordatorios de censo y de carnet.

## Aplicación instalable (PWA)

- **Instalación**: invitación propia en el inicio (botón del navegador en Chrome/Android; instrucciones en
  iPhone/iPad), que no se repite en 30 días si se descarta. Manifest con `id`, accesos directos (Carnet,
  Colonia, Temario), capturas para el diálogo de instalación (`public/screenshots/`) y categorías.
- **Sin conexión**: el service worker (`public/sw.js`) guarda el carnet, el temario, «Mi colonia» y los
  documentos; el carnet pide almacenamiento persistente (`navigator.storage.persist()`).
- **Carnet**: mantiene la pantalla encendida mientras se enseña (Screen Wake Lock).
- **Fotos de los gatos**: botón «Hacer una foto» que abre la cámara trasera en el móvil (`capture`).
- **Anexos en PDF**: además de descargarlos, se pueden compartir (WhatsApp, correo…) con Web Share.
- **Notificaciones push**: se activan en el perfil (o desde la invitación del inicio). Cada aviso
  (alta de colonia, cambio de rol, baja, censo pendiente, carnet a punto de caducar) llega a la vez en la
  app, por correo y como notificación. Implementación sin dependencias con WebCrypto (`src/lib/webpush.ts`:
  cifrado RFC 8291 y VAPID); solo se envía a servicios de push conocidos. En iPhone requiere iOS 16.4 y la
  app instalada. Al cerrar sesión se cancelan en ese dispositivo.
- **Número en el icono** (Badging API): avisos sin leer.
- **Recordatorios** (cron diario 08:00 UTC, `src/lib/reminders.ts`): censo de más de seis meses a la persona
  responsable (no se repite en 30 días) y carnet que caduca en 30 días (no se repite en 45; los carnets sin
  caducidad nunca lo reciben).

Claves VAPID: `node scripts/vapid-keys.mjs` genera el par; la pública va en `VAPID_PUBLIC_KEY`
(`wrangler.jsonc`) y la privada, como JSON, en el secreto `VAPID_PRIVATE_KEY` (y en `.dev.vars` en local).

## Instancia de pruebas y demostración

`demo.colonia.dev` es una copia para pruebas y presentaciones, con los mismos contenidos de San Román pero con
su propia base de datos (`colonias-demo`) y su propio bucket de fotos (`colonias-fotos-demo`). Con `DEMO=1`:

- **Acceso con enlace**: `https://demo.colonia.dev/?codigo=<DEMO_CODE>` (se recuerda 60 días). Sin él solo se ve la portada.
- **Sin correo**: en `/demo` se elige un perfil (empieza el curso, a mitad, lista para el examen, con carnet,
  responsable de colonia o Ayuntamiento). Cada «Entrar como…» crea **una copia nueva** para ese visitante.
- **Atajos**: «Aprobar este tema» y «Rellenar con respuestas de ejemplo» (JEV corrige de verdad).
- **Botón «Demo»**: recorrido de lo que se puede probar con cada perfil, bandeja de correos y cambio de perfil.
- **Bandeja**: los correos no se envían; se guardan en `demo_outbox` y se ven en `/demo/correos`.
- **Solo lectura** en temario, preguntas, documentos, guía y ajustes.
- **Reinicio** cada noche (cron `0 3 * * *`): se borran las copias y se crean los datos de base (colonias en
  distintos estados, carnets vigentes, caducado y revocado, un examen final corregido por JEV…).
- Aviso en todas las páginas, carnets «DEMO · SIN VALIDEZ» (prefijo `DEMO-SRM`), `[Demo]` en los asuntos y `noindex`.

```sh
npm run db:migrate:demo   # migraciones
npm run db:seed:demo      # temario, preguntas y documentos
npm run demo:gatos        # ilustraciones de los gatos (R2 demo-base/)
npm run deploy:demo       # compila con CLOUDFLARE_ENV=demo y despliega
# Reinicio manual:
curl -X POST -H "Origin: https://demo.colonia.dev" -H "Authorization: Bearer $DEMO_RESET_TOKEN" https://demo.colonia.dev/api/demo/reset
```

Secretos (`wrangler secret put … --env demo`): `ADMIN_EMAILS`, `TYPESAFE_API_KEY`, `APP_SECRET`, `DEMO_CODE` y
`DEMO_RESET_TOKEN`. En local: `CLOUDFLARE_ENV=demo npx astro dev` con `.dev.vars.demo`.

## Administración (`/admin`)

Los correos de `ADMIN_EMAILS` obtienen rol de administrador al entrar. Desde el panel se gestionan:
temas (contenido Markdown, orden, peso en el examen final), banco de preguntas (alta/edición/desactivación,
importación y exportación CSV/JSON), ajustes (nº de preguntas, % de aprobado, umbrales JEV, validez del carnet…),
usuarios e intentos (con la puntuación de JEV de cada respuesta escrita) y carnets (revocar/renovar).
En **Ajustes** también se configuran el nombre del municipio, la provincia, el escudo (PNG/JPG/WebP ≤ 1 MB)
y la clave de la API de JEV, que se guarda cifrada con `APP_SECRET` y tiene prioridad sobre `TYPESAFE_API_KEY`.
Si se cambia `APP_SECRET`, la clave guardada deja de poder descifrarse y hay que volver a introducirla.

## Semilla (`npm run db:seed:*`)

- `seed/temarios.json`: manifiesto de temarios (`id`, `nombre`, `descripcion`, `credito`, `carpeta`). Cada carpeta
  tiene `units.json` (orden, slug, título y peso), `units/NN-<slug>.md` y `questions/*.json`. Hoy: `toledo-2025`
  (carpeta `seed`, **no está en el repositorio**, ver «Contenido formativo»; con `solo_con_contenido`, sin sus `.md`
  no se crean sus temas) y `propio` (`seed/temario-propio`, 11 temas y 330 preguntas, CC BY-SA 4.0).
- Crea los temarios que falten (`ON CONFLICT DO NOTHING`: no pisa lo editado en el panel), hace upsert de los temas
  por `(temario_id, slug)` (un tema sin su `.md` se crea con un texto de ejemplo y nunca se sobrescribe) e inserta las
  preguntas cuyo enunciado no exista ya en su tema. **Nunca cambia el temario activo**: un temario nuevo queda
  disponible en *Temarios* para activarlo desde el panel. Para añadir uno: carpeta nueva + entrada en el manifiesto.
- Formato de las preguntas: `docs/preguntas-ejemplo.json`.
- `seed/documents.json`: documentos neutros de la sección «Documentos» (solo se añaden si no existe ya uno con la misma
  URL o con una que encaje con `si_no_existe`). Los de cada municipio van en su precarga (`seed/local/<slug>/`).
- Es idempotente: se puede ejecutar varias veces.

## Correo (enlace de acceso y avisos)

El proveedor se elige así (`chooseProvider` en `src/lib/mail-provider.ts`): simulado con `MAIL_MOCK=1` →
**Resend con la clave guardada en Administración → Ajustes → Correo** → Cloudflare Email Service (binding `EMAIL`) →
Resend con el secreto `RESEND_API_KEY` → ninguno. El remitente del panel tiene prioridad sobre `MAIL_FROM`. Sin
proveedor, o si el envío falla, el correo (con el enlace) se escribe en el log del Worker (`npx wrangler tail`).


El correo se envía con **Cloudflare Email Service** (binding `"send_email": [{ "name": "EMAIL", "remote": true }]` en
`wrangler.jsonc`). En la instalación de San Román el remitente es `no-reply@avisos.colonia.dev`. Para usar otro dominio:

1. `npx wrangler email sending enable <dominio>` (o *Compute → Email Service → Email Sending* en el panel). El dominio
   debe usar los DNS de Cloudflare, que crea los registros SPF, DKIM y DMARC; el envío a cualquier destinatario requiere
   el plan Workers Paid mientras el servicio esté en beta.
2. Poner el remitente en `MAIL_FROM` (`"Nombre <no-reply@dominio>"`).

Todos los correos usan la misma plantilla (`mailTemplate` en `src/lib/email.ts`): HTML completo con el enlace también
visible como texto y un pie que explica quién los envía y por qué, para reducir la probabilidad de acabar en spam.

Alternativas, por orden, si no hay Cloudflare Email Service: **Resend** (secreto `RESEND_API_KEY` y `MAIL_FROM` de un
dominio verificado en Resend) o, sin proveedor, el enlace se escribe en el log del Worker (`npx wrangler tail`), útil
para entrar como administración mientras se configura el correo.

## Contenido formativo

El temario, sus imágenes y el banco de preguntas proceden del *Manual de buenas prácticas en la gestión de colonias
felinas* del **Colegio Oficial de Veterinarios de Toledo**, y su uso en la instalación de San Román está sujeto a la
autorización del Colegio. Por eso **no se incluyen en este repositorio**: cada ayuntamiento debe aportar su propio
temario o contar con los permisos correspondientes. Para desplegar una instancia hacen falta:

- `seed/units/NN-<slug>.md`: un Markdown por tema (los slugs y títulos están en `seed/units.json`).
- `seed/questions/*.json`: el banco de preguntas (formato en `src/lib/questions-io.ts`; también se pueden cargar desde
  Admin → Preguntas → Importar).
- `public/img/temario/`: las imágenes que referencian los temas, y `public/img/hero.jpg` / `hero-640.jpg` (portada).

Los temas y las preguntas también se pueden crear y editar desde el panel de administración. Sin este contenido, la
semilla solo crea el **temario propio** (`seed/temario-propio/`, libre, CC BY-SA 4.0), que la aplicación usa al no
haber temas del de Toledo.
