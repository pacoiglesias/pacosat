# Revisión técnica interna — 2026-11-08

Versión 1.4.0 (revisión original sobre la 1.2.0; al final se añaden las actualizaciones 1.3.0 y 1.4.0). Alcance: lectura del código, configuración y ejecución de pruebas con dependencias SAT/SMTP simuladas. No es certificación, pentest externo ni validación fiscal.

## Corregido

- Actualizaciones del almacenamiento central ignoradas por `INSERT OR IGNORE`: los metadatos ahora se actualizan y cambian la revisión que consultan los clientes. Prueba de regresión en cloud.test.mjs.
- Reintento manual: se valida identificador, existencia, autorización del RFC, estado pendiente y ausencia de procesamiento simultáneo. No crea solicitudes duplicadas.
- Contexto Docker: lista explícita de fuentes necesarias, incluido sat-monitor.mjs; excluye secretos y documentos.
- Verificación de interfaz: corregida la ruta que comprobaba una copia antigua en outputs; ahora verifica el HTML generado del proyecto y compila su JavaScript.
- Operaciones: pendientes sin consulta no se presentan como vigentes; conciliación exige XML existente y RFC coincidente.

## Controles revisados y pruebas

- Rechazo de token, origen y acceso al servidor sin clave del proxy.
- Transacción de almacenamiento: lote inválido revierte cambios.
- Importación: RFC ajeno, deduplicación y validación de ZIP/CRC.
- Respaldo: cifrado, contraseña incorrecta y alteración del archivo.
- Seguimiento: conservación del resultado previo y deduplicación de avisos simulados.

## Pendiente antes de producción

- Conexión real SAT con RFC autorizado, descarga, resultado de cancelación y actualización real del listado 69-B.
- Verificar instalación de dependencias, generar lockfile y ejecutar auditoría de dependencias. No se afirma que estén libres de vulnerabilidades.
  Intento de resolución del 2026-11-08 bloqueado por DNS: ENOTFOUND registry.npmjs.org.
- Probar SMTP real, restauración con expediente representativo y recuperación del volumen SQLite del servidor.
- Verificar interfaz en navegador, tamaños de pantalla y lectores PDF reales.
- El servidor usa una cuenta compartida de confianza; faltan usuarios, roles, MFA y aislamiento entre clientes.
- La API de almacenamiento comprueba límites y tipos básicos, pero requiere validación exhaustiva de cada esquema antes de ofrecer servicio multiusuario.
- Los respaldos de interfaz excluyen credenciales, perfiles SAT, solicitudes y avisos. La recuperación completa del servidor requiere respaldo del volumen y secretos por separado.
- CSP permite scripts inline; reducir esta superficie requiere separar scripts y aplicar nonce/hash.
- Falta una bitácora histórica inmutable y políticas de retención. La interfaz muestra solicitudes recientes, no una auditoría completa de acciones.

Resultado: apto para iniciar pruebas controladas del prototipo; no declarado listo para producción.

## Actualización 1.3.0 — 2026-11-08

Cambios aplicados y verificados en local (`npm run check` en verde, 4 suites + verificación de interfaz):

- **Lockfile generado e instalación verificada**: `npm install` real (26 paquetes) produjo `package-lock.json`; la resolución de dependencias que el intento anterior no pudo comprobar por DNS queda verificada. `Dockerfile`, `Iniciar-Faro.cmd` y el CI instalan con `npm ci`.
- **`.gitignore` protege `config.json` por nombre** (también `*config*.local.json` y `servidor-config.json`): la configuración con la contraseña de la e.firma y la de SMTP ya no depende solo de vivir dentro de `faro-secrets/`.
- **Custodia de la e.firma, verificada en el código**: las contraseñas no se guardan en SQLite (la tabla de perfiles solo conserva RFC, intervalo, días, dirección y próxima revisión); viven en memoria del servicio y en el `config.json` protegido. Los búferes de certificado y llave recibidos al autorizar se ponen a cero tras crear el conector. SERVIDOR.md ahora indica permisos concretos (700/600) para `faro-secrets`.
- **Bitácora visible**: el Resumen muestra «Actividad reciente» con importaciones, descargas SAT, respaldos creados o restaurados, PDF archivados o vinculados y cancelaciones detectadas, con fecha y hora. Sigue sin ser una bitácora inmutable con políticas de retención: ese pendiente se mantiene.
- **Mejora visual**: cabecera con totales del espacio (CFDI · PDF · RFC), lista de actividad con insignias por tipo, tarjetas con realce al pasar el cursor, estilos de impresión y respeto a `prefers-reduced-motion`.
- **Orden**: unificado el `.dockerignore` (se elimina el duplicado `Dockerfile.dockerignore`), LEEME remite al README para la instalación y se añade `LICENSE`.

Pendientes que NO cambian con esta actualización: conexión real con el SAT, SMTP real, CSP sin scripts inline, usuarios/roles/MFA y validación exhaustiva de esquemas antes de un uso multiusuario.

## Actualización 1.4.0 — 2026-11-08: renombre a PacoSAT

- El producto pasa a llamarse **PacoSAT** (antes «Faro Fiscal»): título, marca e interfaz, asuntos de los correos de aviso, mensajes del servicio y documentación. La dirección pública de la instancia en servidor es https://sat.cobertores.com.
- Renombre interno consistente (sin despliegue previo que romper): variables de entorno `FARO_*` → `PACOSAT_*` en código, compose, Caddyfile y ejemplo de `.env`; carpeta `faro-secrets` → `pacosat-secrets`; servicio y volumen de compose `faro`/`faro-data` → `pacosat`/`pacosat-data`; datos en `/var/lib/pacosat`; lanzador `Iniciar-Faro.cmd` → `Iniciar-PacoSAT.cmd`; paquete npm `pacosat` y lockfile regenerado.
- Se mantienen a propósito, por compatibilidad: el archivo generado sigue llamándose `Faro-Fiscal.html` (el paso de verificación de CI en `ci.yml` lo referencia por nombre y ese archivo no es editable desde el conector de GitHub; se renombrará en el mismo paso web que añada `npm ci` al CI), la base IndexedDB `faro-fiscal-v2` y la carpeta local `FaroFiscalLocal` (renombrarlos huérfanaría los datos ya guardados), la magia de respaldo `FARO2` y la extensión `.faro` (compatibilidad con respaldos ya creados), y los identificadores internos de protocolo (metas `faro-token`/`faro-cloud`, cabeceras `x-faro-*`, `createFaroService`, `faro-sat.sqlite`), invisibles para el usuario y cubiertos por las pruebas.
