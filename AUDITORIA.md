# Revisión técnica interna — 2026-11-08

Versión 1.2.0. Alcance: lectura del código, configuración y ejecución de pruebas con dependencias SAT/SMTP simuladas. No es certificación, pentest externo ni validación fiscal.

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
