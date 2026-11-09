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

## Actualización 1.6.2 — 2026-11-08: blindaje contra el error 5002 del SAT

Petición expresa del propietario: poder usar el Web Service una y otra vez sin caer en el bloqueo «de por vida». Verificado antes con investigación con fuentes (informe fuera del repositorio):

- **Lo oficial**: la documentación técnica del SAT del Web Service de Descarga Masiva (v1.5, mayo de 2025) documenta el error **5002, «Se han agotado las solicitudes de por vida»**, como el límite de solicitudes «con el mismo criterio». El SAT no publica la cifra de solicitudes admitidas por criterio ni define oficialmente la exención de Metadata.
- **Lo comunitario**: la cifra — el mismo criterio solo puede solicitarse **dos veces**; la tercera devuelve 5002 — es el criterio empírico de la comunidad técnica (notas de uso de PhpCfdi, corroborado por CONTPAQi y SIFPRO). También es comunitario que cambiar un extremo del periodo en al menos un segundo crea un criterio distinto, y que las solicitudes de tipo Metadata no consumen solicitudes de CFDI. La interfaz y esta nota tratan esas tres afirmaciones como criterio comunitario, no como norma oficial.

**Diseño del libro de criterios** (servidor, `local-server.mjs`):
- Tabla `criteria` **append-only**: solo recibe inserciones, una por cada `SolicitaDescarga` realmente enviado al SAT (manual, programado o sembrado), con el criterio completo: RFC solicitante, sentido (emitidos y recibidos son operaciones separadas ante el SAT), tipo (`cfdi`; el campo queda listo para `metadata`), RFC emisor/receptor cuando se filtren (hoy sin filtro: cadena vacía), fecha inicial y final **con segundos**, IdSolicitud, origen y momento de envío. Nunca se actualiza ni se poda.
- Tabla `criteria_exhausted`: criterios que el SAT ya devolvió agotados (5002), aprendidos aunque el gasto viniera de otra aplicación; es una tabla aparte para no tocar las filas del libro.
- La identidad del criterio es una sola función (`pacosatCriteriaKey`) compartida por la guardia manual, la programada, el aprendizaje y la vista; el desplazamiento de un segundo (`pacosatShiftSecond`) también.
- **Migración suave** al arrancar: `jobs` gana `startAt`/`endAt` por `ALTER TABLE` si faltan; las solicitudes previas reconstruyen sus segundos con la misma regla con la que se enviaron (cierre `23:59:59` si el periodo ya era pasado al enviarse; hora de creación si el cierre era ese mismo día, que es lo que la programación y el envío manual a hoy usaban) y el libro se siembra desde `jobs` **una sola vez** (marca en `automation_state`), sin perder ni duplicar envíos.

**La guardia**, antes de todo envío:
- **Manual** (`/api/request`): criterio con un envío previo → no se envía nada y la respuesta 409 trae el aviso estructurado («este criterio ya se solicitó el <fecha>; repetirlo gasta la última solicitud disponible») con la ventana exacta y la ventana desplazada; la interfaz muestra las salidas: enviar con confirmación expresa, mover el inicio 1 segundo y enviar, o no enviar. Con dos envíos (o agotado aprendido) → **bloqueo**: no hay confirmación que lo fuerce; las salidas son mover el inicio 1 segundo (muestra ventana antigua y nueva), la referencia a Metadata para revisar estados/histórico (con su nota de exención comunitaria; PacoSAT aún no envía solicitudes Metadata) o cancelar.
- **Programada** (`schedule`): red de seguridad silenciosa pero con rastro — las ventanas avanzan y la colisión no debería ocurrir; si el criterio calculado ya se solicitó, el inicio se desplaza +1 s (las veces que haga falta, hasta 10) y el hecho queda anotado en la bitácora («Blindaje SAT 5002») con la ventana original y la desplazada. Nunca se envía un duplicado en silencio ni se detiene la programación sin dejar rastro; si ni desplazando hubiera criterio libre, el error queda en el perfil como cualquier fallo de programación.
- **Aprendizaje**: el conector ahora propaga el `CodigoEstadoSolicitud` de la verificación; si es 5002, el criterio de esa solicitud se marca agotado y se genera **un solo aviso por criterio** por la cola persistente de alertas de la 1.5.0, aunque el libro local solo contara un envío (el gasto pudo venir de otra app).

**Visibilidad**: `/api/status` anota cada solicitud con el estado de su criterio según el libro — «disponible», «última disponible» o «agotado» — y «Solicitudes recientes» lo muestra junto al estado de la solicitud.

**Pruebas** (suites existentes ampliadas, sin dependencias nuevas): identidad de criterio variando cada componente (segundos de inicio y de fin, sentido, tipo, emisor, receptor, RFC) y desplazamiento con cambio de día y de año; en el servicio: primer envío libre, primer repetido que avisa **sin llamar al SAT**, confirmación expresa que envía, segundo repetido bloqueado, desplazamiento de 1 s que produce criterio distinto y pasa, 5002 devuelto al verificar que marca agotado y avisa una sola vez bloqueando incluso con un solo envío local, colisión programada auto-corregida con rastro en la bitácora, y migración que siembra sin duplicar al reabrir (el conteo final es exactamente 2). También se actualizó la expectativa de la llamada programada original: ahora pasa la hora de inicio explícita (`00:00:00`) en lugar de depender del valor por defecto del conector. `npm run check` en verde (5 suites + verificador) y simulación de CI en clon limpio con el diff de generados limpio.

Pendientes que NO cambian: conexión real con el SAT y SMTP real, CSP sin scripts inline, usuarios/roles/MFA, backoff exponencial, migración de identificadores legados y el envío de solicitudes de tipo Metadata (hoy solo referenciado como salida informativa ante un criterio agotado).

## Actualización 1.6.3 — 2026-11-08: la carpeta vigilada recorre subcarpetas

Petición expresa del propietario: sus XML/PDF ya viven en un folder con sus propias carpetas y quiere que la carpeta vigilada los lea así, sin aplanar su orden.

**Diseño** (servidor, `local-server.mjs`, función `collectWatchFiles`):
- **Escaneo recursivo**: cada ciclo recorre todo el árbol bajo la carpeta configurada buscando `.xml`, `.zip` y `.pdf`. Guardas: no se entra nunca en las carpetas de salida del primer nivel (`procesados/` y `errores/`), para no reimportar lo ya movido entre ciclos; se ignoran archivos y carpetas ocultos (nombre que empieza por `.`) y temporales (prefijo `~$`, sufijo `~`); no se siguen enlaces simbólicos y la profundidad se limita a 8 carpetas.
- **Tope por ciclo con orden estable**: se procesan como máximo 20 archivos por ciclo, en orden alfabético de ruta relativa. Como lo procesado sale del árbol al moverse (y lo fallido también), ninguna subcarpeta puede quedarse siempre al final: el resto simplemente espera al siguiente ciclo.
- **Destino con estructura**: lo procesado va a `procesados/AAAA-MM-DD/<ruta relativa>` y lo fallido a `errores/<ruta relativa>`; el orden del propietario no se aplana. Si el destino ya contuviera un archivo con ese nombre, se añade un sufijo numérico (` (2)`, ` (3)`…) en vez de pisarlo; los homónimos de subcarpetas distintas ya quedan distinguidos por su propia ruta.
- **Trazabilidad por ruta relativa**: la bitácora (incidencias del ciclo, incluido el desglose de entradas de un ZIP como `<ruta> · <entrada>`), los avisos por correo y el nombre con el que se archiva un PDF vinculado registran la ruta relativa completa, no solo el nombre del archivo. La clave de «atascado» y la de deduplicación de avisos también pasan a ser la ruta relativa.
- **Visibilidad**: `/api/status` anuncia `watchFolder.subfolders: true` y las vistas de Operaciones y de Respaldos muestran «incluye subcarpetas» junto al estado de la carpeta vigilada.

El resto del comportamiento de la 1.6.0 no cambia: mismas reglas del importador (RFC registrado, deduplicación por UUID), el PDF solo se vincula si su UUID ya está en el expediente, aviso por la cola persistente ante fallos y estado visible en Operaciones y Respaldos.

**Pruebas** (suite `cloud.test.mjs` ampliada, sin dependencias nuevas): árbol anidado de 3 niveles importado entero en un ciclo; `procesados/` y `errores/` excluidos del escaneo (archivos semilla intactos y segundo ciclo sin novedades: sin bucles); enlace simbólico a una carpeta no seguido (su contenido solo entra por la ruta real); archivo oculto ignorado; PDF en subcarpeta vinculado con su ruta como nombre archivado; archivo dañado en subcarpeta profunda apartado en `errores/` conservando su ruta, con la incidencia y el aviso llevando la ruta relativa; homónimos en subcarpetas distintas movidos sin pisarse, y colisión contra un archivo ya presente en el destino resuelta con sufijo numérico sin tocar el original; tope de 20 por ciclo con 25 archivos en una subcarpeta: el primer ciclo mueve 20 y el segundo los 5 restantes, sin crear duplicados. `npm run check` en verde (5 suites + verificador) y simulación de CI en clon limpio con el diff de generados limpio.

## Actualización 1.6.4 — 2026-11-08: ronda de endurecimiento (respaldo completo, cobertura y carpeta vigilada robusta)

Tres frentes de una revisión externa validada con el propietario. Sin dependencias nuevas y dentro de la CSP vigente.

**Frente 1 — Respaldo completo y recuperable.**
- *Verificación del supuesto de la revisión*: el límite de 100 MB **sí existe** y en tres sitios coherentes — el snapshot del servidor (`snapshotFromRecords`), la subida y bajada por `/api/storage` y el snapshot del navegador (`workflows.part`) — y es un límite del formato .faro completo («Este formato admite hasta 100 MB de archivos por respaldo»). En 1.6.4 se mantiene y se aplica al conjunto: bytes de archivos + tamaño del estado operativo serializado.
- *Mecanismo elegido*: **volcado versionado dentro del mismo .faro cifrado**, no una copia binaria de SQLite. El .faro sigue siendo v2 (las restauraciones de versiones anteriores siguen funcionando: ignoran la sección nueva) y añade `operations: { version: 1, … }` con perfiles, `jobs` (con el nuevo contador de verificaciones), `packages` **sin** la columna `archive` (los ZIP sin importar se vuelven a descargar con su IdSolicitud; al importarse, sus XML ya son expediente), `criteria` y `criteria_exhausted` completos, `notices`/`alerts`/`cancellation_alert`/`efos_alert` **solo pendientes** (lo enviado es historia, no estado), `alert_state`, `automation_state`, `discovered`, `cfdi_watch` y `efos_meta`. La lista 69-B (`efos_rfc`) se excluye a propósito: se descarga de nuevo del SAT. Expediente y estado se leen en **una sola transacción de lectura**, así la copia es una foto coherente de un mismo instante.
- *Lo que nunca viaja*: la e.firma (vive solo en memoria durante la sesión; sus archivos están en `pacosat-secrets`, fuera del respaldo por diseño) y las credenciales SMTP (configuración del servidor, no dato). Al restaurar el estado, los perfiles quedan bloqueados hasta desbloquear cada e.firma: es el comportamiento correcto, no una pérdida.
- *Restauración*: el diálogo de restaurar vuelca las tiendas como siempre y, si el respaldo trae `operations` y hay servidor, lo envía a `POST /api/backup/operations`, que lo valida (versión, arrays con tope de filas) y lo reemplaza en una transacción respetando el orden de claves foráneas. Un respaldo anterior a 1.6.4 se restaura igual que antes y no toca el estado.
- *Destino secundario*: `backup.secondaryDir` en el archivo de arranque; recibe el mismo buffer cifrado. Su fallo no invalida el respaldo principal: queda en `backup:secondaryError`, visible en Respaldos, con aviso propio por la cola.
- *Prueba de restauración*: `POST /api/backup/verify` y botón en Respaldos; descifra el .faro más reciente de cada destino con la contraseña configurada y valida estructura y conteos (versión, tiendas, bytes de archivos, conteos del estado) **sin tocar la base activa**. Corre también automáticamente tras cada respaldo programado contra lo recién escrito. Cada ejecución deja apunte en la bitácora («Prueba de restauración») y el último resultado se ve en Respaldos.
- *Expedientes que superen 100 MB*: queda **documentada, no implementada**, la partición prevista: un .faro por RFC y año (cada registro del expediente lleva RFC y fecha; el estado operativo, pequeño, iría completo en cada parte), porque partir el formato exige migrar también el restaurador del navegador.

**Frente 2 — Cobertura por RFC y reintentos con espera creciente.**
- *Backoff*: la verificación de solicitudes pendientes abandona el ritmo fijo de 5 min sin tope (hallazgo M-4 de la ronda 2). Nueva columna `jobs.checks` (migración suave como la de 1.6.2): tras cada verificación que sigue pendiente, la espera es 5·2^checks minutos con tope de 60 (5 de creación, luego 10, 20, 40, 60). Antes del intento se reprograma ya con la espera vigente por si el proceso muere a mitad. Al llegar al tope por primera vez queda un apunte en la bitácora. La suite de servicio que codificaba la cadencia fija se actualizó a la nueva cadencia siguiendo los propios pasos del backoff, manteniendo las mismas aserciones de avisos (un aviso por episodio de 3 fallos, reinicio al recuperarse, segundo episodio, segundo aviso).
- *Modelo de cobertura* (`computeCoverage`, en cada `/api/status`): por RFC y sentido, tramos terminados fusionados (contiguos si se tocan o se solapan con ≤1 s), «verificado hasta» = fin del primer tramo continuo, conteos de en curso/fallidos y de criterios agotados (del libro, `type='cfdi'`). Hueco: segundos sin cubrir entre dos tramos > 0; **micro-hueco** si son 1–2 s (las costuras del desplazamiento +1 s del blindaje). Días cubiertos por RFC y sentido para el mapa de calor.
- *Vista «Cobertura»* (nueva vista y `coverage-ui.part`): tabla por RFC y sentido, lista de huecos con su tipo, y mapa de calor anual en SVG generado (semanas × 7 días, nivel por sentidos cubiertos, `<title>` por celda, tokens del sistema de diseño, modo oscuro y leyenda) con selector de año.
- *Conciliación sin auto-solicitud*: en cada ciclo del servicio se compara la firma del conjunto de huecos con la guardada; si cambia a un conjunto no vacío, se anota UNA entrada «Conciliación de cobertura» en la bitácora listando los huecos y proponiendo pedirlos desde el Centro SAT. PacoSAT no envía ninguna solicitud por su cuenta.

**Frente 3 — Ingesta robusta en la carpeta vigilada** (sobre la 1.6.3).
- *Espera de estabilidad*: cada candidato debe verse igual (tamaño y mtime) en dos `stat` separados por una espera corta (2 s por defecto; opción `watchSettleMs` para pruebas). El que cambia o desaparece espera al siguiente ciclo y se cuenta como «en espera (copiándose)» en el estado, sin marcarse atascado ni fallido.
- *Tamaño antes de leer*: el límite se comprueba con `stat` antes de cualquier lectura (XML 8 MB y ZIP 80 MB, los que ya aplicaba el importador al contenido; PDF 20 MB, el mismo tope que acepta el análisis de PDF del servidor). El exceso se rechaza con su motivo sin cargar el archivo; las comprobaciones sobre el contenido quedan como segunda línea.
- *Tres resultados*: procesado (`procesados/AAAA-MM-DD/<ruta>`), **procesado con incidencias** — un ZIP con entradas válidas y fallidas: el contenedor va a la nueva carpeta `incidencias/<ruta>` (excluida del escaneo como las demás salidas), el desglose por entrada queda en la bitácora y un aviso por la cola resume las primeras incidencias — y rechazado (`errores/<ruta>`). Un ZIP sin ninguna entrada válida es rechazo, no incidencia. Contadores nuevos en el estado: `watchFolder.incidents` y `watchFolder.waiting`, visibles en Operaciones y Respaldos.

**Pruebas**: `service.test.mjs` — progresión del backoff 10/20/40/60 con contador persistido y apunte único al llegar al tope, además de la cadencia actualizada del episodio de fallos persistentes. `cloud.test.mjs` — ida y vuelta del estado operativo: un servicio genera perfiles, una solicitud rechazada con 5002 aprendido (criterio agotado + alertas que quedan pendientes porque el SMTP simulado falla) y una pendiente con `checks=1`; el respaldo programado escribe en principal y secundario; el .faro del secundario se descifra y se valida sección a sección; la prueba de restauración responde íntegra y queda en bitácora; un segundo servicio restaura el estado por la API y el estado del criterio vuelve a ser «agotado» con el contador intacto. Cobertura: base sembrada con dos tramos separados por una costura de 2 s, un hueco de días, un pendiente, un rechazado y un criterio agotado → verificado-hasta, conteos, huecos (uno micro), días y una sola nota de conciliación en dos ciclos. Carpeta vigilada: un archivo que crece durante el ciclo no se procesa y se procesa en el siguiente ya estable; un XML de 8 MB+1 se rechaza por tamaño con su motivo en la bitácora; un ZIP mixto en subcarpeta acaba en `incidencias/lotes/` con el desglose por entrada y su aviso por correo, y un ciclo extra no reprocesa ninguna salida. `npm run check` en verde (5 suites + verificador) y simulación de CI en clon limpio con el diff de generados limpio.

## Hallazgo de despliegue — 2026-11-08: la imagen Docker no incluía backup-core.mjs

Al desplegar en el NAS la serie 1.6.0, la aplicación entró en bucle de reinicio con `ERR_MODULE_NOT_FOUND`: el `Dockerfile` y el `.dockerignore` del repositorio no incluían `backup-core.mjs`, el módulo que `local-server.mjs` importa desde la 1.6.0 para compartir el cifrado de respaldos con el navegador. En el NAS se parchearon los archivos desplegados y el servicio quedó en marcha, pero el repositorio seguía roto para Docker: cualquier redespliegue desde el `Dockerfile` del repo habría vuelto a caer. La CI no lo detectó porque no construye la imagen: las suites importan los módulos desde el árbol completo del repo, donde el archivo sí existe.

**Corrección** (micro-PR posterior a la 1.6.4, sin cambio de versión: el código de la aplicación no cambia):
- `Dockerfile`: la línea `COPY` de la aplicación incluye `backup-core.mjs`. Revisado el grafo completo de imports relativos del punto de entrada (`local-server.mjs` → `backup-core.mjs`, `pdf-invoice.mjs`, `sat-direct.mjs`, `sat-monitor.mjs`, `xml-core.mjs`, más el propio `local-server.mjs` y el activo `Faro-Fiscal.html`): era el único módulo fuera.
- `.dockerignore`: la lista de permitidos incluye `!backup-core.mjs` (sin esto, el `COPY` tampoco lo habría traído: el contexto de build lo excluía).
- **Guarda permanente en `verify.cjs`**: recorre los imports relativos alcanzables desde `local-server.mjs` y exige que cada archivo esté en el `COPY` del `Dockerfile` y en la lista de permitidos del `.dockerignore`; si falta alguno, la CI falla con el nombre del archivo. Verificado en ambos sentidos: pasa con la corrección y falla con el `Dockerfile` anterior señalando exactamente `backup-core.mjs`.
