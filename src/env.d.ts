/// <reference types="astro/client" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PHOTOS: R2Bucket;
    LOGIN_LIMITER: RateLimit;
    APP_NAME: string;
    MAIL_FROM: string;
    ADMIN_EMAILS: string;
    JEV_MOCK: string;
    MAIL_MOCK: string;
    /** "1" en la instancia de pruebas y demostración. */
    DEMO?: string;
    /** Código del enlace de acceso a la demo (?codigo=…). */
    DEMO_CODE?: string;
    /** Token para reiniciar la demo desde fuera (POST /api/demo/reset). */
    DEMO_RESET_TOKEN?: string;
    /** Dirección pública de la web (enlaces de los avisos enviados desde el cron). */
    APP_ORIGIN?: string;
    /** Clave pública VAPID de las notificaciones push (base64url, sin comprimir). */
    VAPID_PUBLIC_KEY?: string;
    /** Clave privada VAPID en formato JWK (secreto). */
    VAPID_PRIVATE_KEY?: string;
    TYPESAFE_API_KEY?: string;
    /** Clave para cifrar los secretos guardados desde el panel (mín. 16 caracteres). */
    APP_SECRET?: string;
    RESEND_API_KEY?: string;
  }
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}

declare namespace App {
  interface Locals {
    user: import("./lib/auth").SessionUser | null;
    branding: import("./lib/branding").Branding;
    /** Programa municipal: normativa, nombres de los anexos, censo… (Administración → Programa local). */
    programa: import("./lib/programa-config").Programa;
    /** Temario activo (Administración → Temarios): id, nombre y crédito de autoría. */
    temario: import("./lib/temarios").TemarioInfo;
    /** El usuario tiene un carnet vigente: modo «consulta» (sin tests ni examen). */
    hasCarnet: boolean;
    /** En la demo: si el visitante ha entrado con el enlace con código. */
    demoAccess?: boolean;
  }
}
