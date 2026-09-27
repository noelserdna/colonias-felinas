# Temario propio (borrador)

Temario de formación de personas colaboradoras en la gestión de colonias felinas, redactado para sustituir al basado en
el manual del Colegio de Veterinarios de Toledo (que sigue en `seed/units/`, fuera de git). **Estado: borrador pendiente
de validar** (ver `REVISION.md`).

- `units.json` y `units/NN-slug.md`: 11 temas universales (cualquier municipio, urbano o rural), unas 17.800 palabras (Toledo: 8 temas, 15.300).
- `local/san-roman-de-los-montes.md`: suplemento local de San Román (ordenanzas, Castilla-La Mancha, trámites, contactos); sirve de plantilla para otros municipios. `local/fragmentos/`: todo lo retirado de los temas, con su referencia.
- Imágenes en `public/img/curso/<slug>/` (fotos con licencia libre) y `public/img/curso/diagramas/` (esquemas propios).
- `CREDITOS.md`: autor, licencia y origen de cada imagen. `REVISION.md`: lo que deben confirmar el veterinario (V) y el
  Ayuntamiento (A). `creditos/` y `revision/`: lo mismo, por tema.
- Licencia del texto y los esquemas: CC BY-SA 4.0 (compatible con las fotos CC BY-SA que se usan).
- Material de partida (fuera del repositorio, en la carpeta `investigacion-curso/` junto a la del repositorio): fuentes, notas por tema y
  `GUIA-REDACCION.md` con la estructura, el tono y los datos acordados.

En la aplicación es el temario `propio` de `seed/temarios.json`: la semilla lo crea (con `questions/`) sin activarlo, y
se activa desde *Administración → Temarios*. Como cada temario tiene sus propios temas, los slugs que coinciden con el
de Toledo (`metodo-cer`, `programa-municipal`) no se pisan.