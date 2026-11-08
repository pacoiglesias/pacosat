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

- **Lockfile generado e instalación verificada**: `npm install` real (26 paquetes) produjo `package-lock.json`; la resolución de dependencias que el intento anterior no pudo comprobar por DNS queda verificada. `Dockerfile`, el lanzador de Windows y el CI instalan con `npm ci`.
- **`.gitignore` protege `config.json` por nombre** (también `*config*.local.json` y `servidor-config.json`): la configuración con la contraseña de la e.firma y la de SMTP ya no depende solo de vivir dentro de la carpeta de secretos del servidor.
- **Custodia de la e.firma, verificada en el código**: las contraseñas no se guardan en SQLite (la tabla de perfiles solo conserva RFC, intervalo, días, dirección y próxima revisión); viven en memoria del servicio y en el `config.json` protegido. Los búferes de certificado y llave recibidos al autorizar se ponen a cero tras crear el conector. SERVIDOR.md ahora indica permisos concretos (700/600) para la carpeta de secretos.
- **Bitácora visible**: el Resumen muestra «Actividad reciente» con importaciones, descargas SAT, respaldos creados o restaurados, PDF archivados o vinculados y cancelaciones detectadas, con fecha y hora. Sigue sin ser una bitácora inmutable con políticas de retención: ese pendiente se mantiene.
- **Mejora visual**: cabecera con totales del espacio (CFDI · PDF · RFC), lista de actividad con insignias por tipo, tarjetas con realce al pasar el cursor, estilos de impresión y respeto a `prefers-reduced-motion`.
- **Orden**: unificado el `.dockerignore` (se elimina el duplicado `Dockerfile.dockerignore`), LEEME remite al README para la instalación y se añade `LICENSE`.

Pendientes que NO cambian con esta actualización: conexión real con el SAT, SMTP real, CSP sin scripts inline, usuarios/roles/MFA y validación exhaustiva de esquemas antes de un uso multiusuario.

## Actualización 1.4.0 — 2026-11-08: renombre a PacoSAT

- El producto pasa a llamarse **PacoSAT** (sustituye al nombre anterior del proyecto): título, marca e interfaz, asuntos de los correos de aviso, mensajes del servicio y documentación. La dirección pública de la instancia en servidor es https://sat.cobertores.com.
- Renombre interno consistente (sin despliegue previo que romper): variables de entorno con el prefijo nuevo `PACOSAT_*` en código, compose, Caddyfile y ejemplo de `.env`; carpeta de secretos con el nombre nuevo `pacosat-secrets`; servicio y volumen de compose `pacosat`/`pacosat-data`; datos en `/var/lib/pacosat`; lanzador `Iniciar-PacoSAT.cmd`; paquete npm `pacosat` y lockfile regenerado; identificadores internos de protocolo (función del servicio, metas y cabeceras de sesión, marcador de plantilla, dominio de message-id, base SQLite `pacosat.sqlite` y carpeta local `PacoSATLocal`) alineados con el nombre nuevo y verificados por la batería de pruebas.
- Excepciones que se mantienen a propósito, por compatibilidad, y son las únicas apariciones del nombre anterior que quedan en el repo: el archivo generado sigue llamándose `Faro-Fiscal.html` (el paso de verificación de CI en `ci.yml` lo referencia por nombre y ese archivo no es editable desde el conector de GitHub; se renombrará en el mismo paso web que añada `npm ci` al CI), la base IndexedDB `faro-fiscal-v2` y la magia de respaldo `FARO2` con la extensión `.faro` (renombrarlos huérfanaría los expedientes del navegador y los respaldos ya creados; su migración segura queda como paso futuro planificado).

## Actualización 1.5.0 — 2026-11-08: segunda auditoría (producción) y avisos completos

Segunda revisión, esta vez sobre el sistema ya desplegado en el NAS (Docker + Caddy tras Cloudflare Tunnel, acceso con autenticación básica): el informe completo vive fuera del repositorio. Cambios aplicados y verificados en local (`npm run check` en verde, con las suites de monitor y servicio ampliadas):

- **Avisos que faltaban, sobre el patrón de cola persistente existente** (`due`/`sent`, reintento a +15 min, sin duplicados): (1) alta nueva — o situación Presunto/Definitivo nueva — de un RFC que es emisor o receptor de CFDI vigilados en el listado 69-B, con diff contra el snapshot anterior y siembra silenciosa en la primera carga; (2) fallo persistente de la descarga automática, con contador por RFC de intentos consecutivos con error (verificación de solicitudes o programación) que avisa una vez por episodio a los 3 intentos y se reinicia al recuperarse; (3) solicitud que el SAT deja vencida, fallida o rechazada, avisando al detectarse la transición y recordando que debe crearse una solicitud nueva. Las alertas del monitor comparten su cola; las del servicio de descargas usan una tabla `alerts` propia con el mismo protocolo, porque la cola `notices` está ligada por clave foránea a paquetes.
- **Totales por RFC y mes en el Resumen**: emitidos y recibidos con conteos e importes sumados al centavo (BigInt); los importes en moneda distinta de MXN se cuentan pero no se suman, y se anota. Exportación CSV del resumen.
- **Contador de novedades**: insignia en la navegación y nota en el Resumen con lo registrado en la bitácora desde la última visita, con la marca guardada en el navegador.
- **Orden**: normalizados a LF los cuatro archivos `.mjs` que conservaban un final CRLF pese a `.gitattributes`; corregido un resto del renombre en un mensaje de consola («Faro» → «PacoSAT», sin tocar los identificadores legados protegidos); SERVIDOR.md documenta la variante de despliegue tras Cloudflare Tunnel que corre en el NAS y el ejemplo de `.env` usa un dominio marcador.

Pendientes que NO cambian: conexión real con el SAT y SMTP real (esperan las credenciales del propietario en el servidor), CSP sin scripts inline, usuarios/roles/MFA, backoff exponencial en la verificación de solicitudes y la migración segura de los identificadores legados. La contraseña de acceso actual es débil por decisión del propietario para la fase de pruebas; el informe recomienda endurecerla al activar la e.firma y valorar Cloudflare Access como segunda puerta.

## Actualización 1.6.0 — 2026-11-08: rediseño completo y funciones nuevas

Tercera ronda, con el objetivo declarado de superar visual y operacionalmente a las herramientas comerciales de descarga masiva. Todo verificado en local (`npm run check` en verde, con la suite de nube ampliada y una comprobación cruzada de respaldos en el verificador). Sin dependencias nuevas: los gráficos y los iconos son SVG generados en el propio documento y los sonidos se sintetizan con WebAudio, para no tocar la CSP estricta.

- **Sistema de diseño y modo oscuro**: tokens de color únicos para claro y oscuro; el oscuro sigue a `prefers-color-scheme` y se puede fijar con el interruptor de la cabecera (la preferencia se guarda en el navegador). El resto de la hoja de estilos consume los mismos tokens, así que no quedan colores sueltos sin versión oscura.
- **Iconos SVG propios** en la navegación (incluida la nueva vista de la base DIOT), acciones y estados: campana, escudo, llave, correo, gráfico, bandeja, impresión, sol/luna, volumen y silencio, entre otros, con trazo y tamaño consistentes.
- **Resumen nuevo**: fila de indicadores (CFDI vigentes y cancelados según la vigilancia, importe del mes en curso con desglose emitidos/recibidos, descargas en curso y última actividad) y gráfico SVG de totales por mes de los últimos seis meses, emitidos contra recibidos, con valores y leyenda.
- **Sonidos**: tonos breves y discretos para éxito, error, aviso nuevo y cancelación detectada, sintetizados con WebAudio. Solo suenan tras la primera interacción con la página (política de autoplay) y el interruptor de la cabecera los apaga de forma persistente.
- **Reporte mensual por RFC** para imprimir o guardar en PDF (`@media print` dedicado): totales y conteos por contribuyente del mes elegido, más cancelados y coincidencias 69-B según la última consulta de vigilancia disponible, marcada como parcial si la vigilancia no ha corrido.
- **Base para la DIOT**: vista y CSV con totales por RFC proveedor y mes desde los CFDI recibidos. La propia vista aclara que es base de trabajo para la contadora, no la declaración: el importador no guarda el desglose de IVA.
- **Filtro por estado SAT** en el archivo de CFDI (vigente, cancelado, con 69-B o sin consulta), sobre la misma consulta que ya alimentaba Operaciones.
- **Carpeta vigilada** (solo servidor): importa en cada ciclo los XML/ZIP/PDF que caen en la carpeta configurada reutilizando el importador existente; mueve lo procesado a `procesados/AAAA-MM-DD/` y lo fallido a `errores/`, con registro en la bitácora y aviso por correo ante fallos. XML y ZIP se importan con el analizador del núcleo; el PDF se vincula solo si su UUID ya está en el expediente.
- **Respaldo cifrado programado** (solo servidor): diario o semanal, en el formato exacto del respaldo manual — la lógica de cifrado se comparte en `backup-core.mjs` y el verificador comprueba la compatibilidad cruzada navegador/servidor en ambos sentidos —, con estado visible en Operaciones y Respaldos y aviso por correo si falla.

**Fuera de alcance, por decisión documentada**: emisión/timbrado de CFDI (requiere un PAC; el propietario timbra en Más Facturas), buzón tributario y trámites del portal con CIEC (scraping con captcha, fuera del canal oficial por Web Service) y descarga de retenciones (el SDK integrado no la expone sin dependencias nuevas). Pendientes que NO cambian: conexión real con el SAT y SMTP real, CSP sin scripts inline, usuarios/roles/MFA, backoff exponencial y migración de identificadores legados.

## Actualización 1.6.1 — 2026-11-08: validador completo de RFC

Mini-actualización a petición del propietario: que al teclear un RFC el programa diga si es válido o no. Hay una sola función, `validateRfc` en `data.part` (se genera también a `xml-core.mjs`), y la usan la interfaz y el servidor.

**Qué valida** (validación de forma, en este orden):
- **Estructura**: 13 caracteres de persona física (4 letras + 6 de fecha + 2 de homoclave + dígito verificador) o 12 de persona moral (3 letras). Las letras admiten Ñ y &; la homoclave es alfanumérica; el último carácter es un dígito o la letra «A».
- **Fecha embebida**: mes de 01 a 12 y día válido para ese mes, con años bisiestos por la regla de divisibilidad entre 4.
- **Dígito verificador oficial**: el algoritmo publicado por el SAT (tabla de valores del Anexo III — el valor es la posición en la cadena `0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ`: espacio 37, & 24, Ñ 38 —, pesos de 13 a 2 sobre la base de 12 posiciones anteponiendo un espacio cuando la base es de 11, suma módulo 11: residuo 0 → «0», residuo 1 → «A», otro residuo → 11 menos el residuo). Verificado contra el ejemplo resuelto del propio documento del SAT (`GODE561231GR`, suma 1026 → `GODE561231GR8`) y contra RFC reales en uso.

**Qué NO valida**: la existencia del RFC en el SAT. Ninguna comprobación local puede hacerlo: eso lo confirma el SAT (constancia de situación fiscal o, en la práctica, la primera interacción del Web Service con la e.firma, donde además el certificado manda). La interfaz lo dice en cada mensaje para no vender una cosa por otra.

**Decisiones de criterio**:
- Error de estructura o de fecha: **bloquea** el guardado, con el mensaje concreto de qué falla.
- Dígito verificador que no cuadra: **aviso fuerte de probable errata, sin bloqueo absoluto**. Solo se guarda marcando la casilla expresa «Guardar aunque el dígito verificador no cuadre». Motivo: existen RFC reales antiguos cuyo dígito no sigue el algoritmo, y un bloqueo total dejaría fuera expedientes legítimos; el silencio, en cambio, colaría erratas que luego hacen fallar la descarga.
- **Genéricos del SAT** (`XAXX010101000` y `XEXX010101000`): se detectan y se aceptan con nota, sin exigirles el dígito — el de público en general no lo cumple por diseño (su base daría «4»); el de extranjeros sí lo cumple.

**Un solo criterio, con dos niveles documentados**: el alta de contribuyentes aplica el validador completo. El importador de CFDI (mismo núcleo, navegador y servidor) exige estructura y fecha a emisor y receptor, pero no el dígito: en los CFDI reales aparecen los genéricos y el dato ya viene emitido por el SAT. El servidor, al guardar perfiles (`/api/unlock` y perfiles de arranque del archivo de configuración), bloquea con error de estructura o fecha y no con el dígito, porque su puerta decisiva es que el RFC del certificado de la e.firma coincida con el del expediente. Mantienen la expresión estructural anterior, a propósito: la restauración de respaldos (lo ya guardado no se revalida con efectos destructivos) y la validación de datos que llegan del SAT en el monitor y en el conector (sujeto del certificado y filas de estado), donde el dato del SAT es el que manda.

**Pruebas**: suite nueva `rfc.test.mjs` con los vectores externos (ejemplo del SAT y RFC reales), los casos de residuo 0 y residuo 1 («A»), Ñ y &, ida y vuelta generando dígitos y rompiéndolos, genéricos, y cada error de estructura y de fecha con su mensaje. `npm run check` en verde (5 suites + verificador) y simulación de CI en clon limpio con el diff de generados limpio.
