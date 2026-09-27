-- Varios temarios: tabla nueva, temario de cada tema y temario con el que se hizo cada final y se emitió cada carnet.
-- Migración solo aditiva (sin reconstruir `units`, que tiene claves ajenas entrantes de questions y attempts).
CREATE TABLE `temarios` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`descripcion` text,
	`credito` text,
	`oculto` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Todos los temas existentes pertenecen al temario del manual de Toledo (el activo por defecto).
INSERT INTO `temarios` (`id`, `nombre`, `descripcion`, `credito`, `oculto`, `created_at`, `updated_at`) VALUES ('toledo-2025', 'Manual de buenas prácticas del Colegio de Veterinarios de Toledo (2025)', NULL, NULL, 0, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000);--> statement-breakpoint
DROP INDEX `units_slug_unique`;--> statement-breakpoint
ALTER TABLE `units` ADD `temario_id` text DEFAULT 'toledo-2025' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `units_temario_slug_unique` ON `units` (`temario_id`,`slug`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `temario_id` text;--> statement-breakpoint
ALTER TABLE `carnets` ADD `temario_id` text;--> statement-breakpoint
-- Los finales y carnets anteriores se hicieron con el temario de Toledo.
UPDATE `attempts` SET `temario_id` = 'toledo-2025' WHERE `kind` = 'final' AND `temario_id` IS NULL;--> statement-breakpoint
UPDATE `carnets` SET `temario_id` = 'toledo-2025' WHERE `temario_id` IS NULL;
