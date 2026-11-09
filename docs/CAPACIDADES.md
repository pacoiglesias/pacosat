# PacoSAT — Qué incluye (documento vivo)

**Versión del software que describe este documento: 1.7.1**

**Última modificación: 9 nov 2026, 09:50 CST**

Estados: ✅ incluido y verificado · 🔄 en construcción (cadena de rondas en marcha) · 📋 planificado en la cadena.
Este documento vive en dos copias idénticas: `docs/CAPACIDADES.md` del repositorio (la FUENTE del listado: la app lo muestra dentro, en la pantalla «Qué incluye PacoSAT», generada desde él en cada build) y `~/workspace/pacosat-capacidades.md` (copia de trabajo). Al tocar una, se toca la otra en el mismo cambio. Se actualiza en cada ronda y cada despliegue, junto con el sello de versión.

## 1. Núcleo CFDI
- ✅ Importación de XML y ZIP con validación, y vinculación de PDF.
- ✅ Visor CFDI profesional: datos completos, conceptos e impuestos, cadena original, Timbre Fiscal, complemento de Pagos 2.0 y representación impresa.
- ✅ Vinculación PDF ↔ XML por UUID: el PDF de la factura se lee, se detecta su folio fiscal y se vincula al XML del mismo UUID (con cotejo de RFC); el importe del PDF no se compara con el del XML.
- ✅ Línea de tiempo por CFDI y buscador global.
- ✅ Mapa de cobertura por periodos y gráfica de estados. (En el anillo de estados, «No encontrado» se suma dentro de «Sin consulta»; el detalle de cada CFDI sí muestra «No encontrado» como estado propio.)
- ✅ Persistencia del desglose fiscal al importar (subtotal, IVA por tasa, IEPS, retenciones, método/forma de pago, uso CFDI, tipo de cambio, serie/folio) con re-parseo histórico: base de la DIOT (1.6.16; la relación de pagos se sumó en la 1.6.17).
- ✅ Detector al importar de duplicados por UUID y de CFDI cuyo RFC no corresponde al expediente; el detector de totales que no cuadran y de folios repetidos con otro UUID actúa sobre lo ya guardado (pantalla Cumplimiento, 1.6.18).

## 2. Descarga y vigilancia del SAT
- ✅ Descarga masiva oficial por Web Service con e.firma (SDK), por RFC y dirección (emitidos/recibidos), con paquetes ZIP.
- ✅ Perfiles multi-RFC con cadencia propia (Mano Fil: cada 360 min, ventana 7 días, ambas direcciones).
- ✅ Vigilancia de estado de cada CFDI cada 24 h y de cancelaciones.
- ✅ Escudo de criterios 5002 (ronda anti-5002, 1.7.1): ningún criterio (ventana con los segundos exactos + dirección + RFC + tipo de solicitud) se envía dos veces en la vida. El libro de criterios es permanente y toda ruta lo consulta antes de pedir; la única salida al SAT, `sendSatRequest`, rechaza con guardia 409 cualquier criterio con usos previos o marcado agotado, incluidas las intenciones «enviando» que quedaron a medias — la última solicitud idéntica nunca se gasta (ya no hay confirmación posible para repetirla). La salida es siempre la variante de cierre +1 s (el inicio nunca se mueve: no se pierde el primer segundo ni quedan huecos entre ventanas): la descarga programada la aplica sola y la manual la ofrece en un clic. El PLANIFICADOR ensaya cada solicitud sin gastar cupo (mismo código que construye el criterio de verdad) y, si un rango CFDI nuevo supera 31 días, propone pedir primero Metadata. El LIBRO DE CRITERIOS se ve por RFC en Centro SAT (qué se pidió, cuándo, por qué vía y en qué estado quedó: sin usar, usado, quemado 5002 o rescatado). Y si el SAT devuelve un 5002 (por ejemplo, un criterio gastado antes por otra app), el criterio queda marcado quemado con su explicación y el RESCATE asistido prepara la lista de folios pendientes para bajarlos por el portal (canal aparte, hasta 2.000 XML/día); lo que entra por la carpeta vigilada dentro de una ventana quemada la marca «rescatada».
- ✅ Solicitudes Metadata (hasta 1.000.000 de registros ligeros por petición) para reconciliar cobertura (1.6.10): automáticas una al día por RFC y a petición por periodo; los CFDI que el SAT conoce y faltan en XML se listan en Cobertura.
- ✅ Recibidos SIN filtro de «solo vigentes», registrando el estado inicial de cada CFDI (1.6.10): el conector ya no envía filtro de estado y el estado inicial llega de los metadatos al detalle del CFDI.
- ✅ Blindaje (1.6.15): intención registrada ANTES de enviar («presunto enviado» al arrancar, con aviso), base de datos con synchronous=FULL a prueba de cortes, timeout duro de 60 s en llamadas al SAT con vigilante del ciclo (aviso si un ciclo pasa de 10 minutos), y contador de descargas por paquete con tope 5008: a los 2 intentos la solicitud se cierra en un estado terminal claro con aviso y salida accionable.
- ✅ Carpeta vigilada recursiva: todo CFDI que caiga en la carpeta entra solo.
- ✅ Solicitudes frecuentes EN UN CLIC (1.6.10) («mes pasado completo», «este trimestre», «este año») sin teclear fechas: menos errores y menos criterios 5002 quemados por un dedo mal puesto.
- ✅ AVISO DE SILENCIO **CONFIGURABLE** + MODO DESCANSO CON **INTERRUPTOR ON/OFF** (petición expresa de Paco: visual, práctico e intuitivo): un interruptor grande y visible — general en la pantalla «Hoy» y uno por RFC — para encender/apagar la vigilancia en un toque, con el estado siempre claro («Vigilando» / «Descansando») y opción de «descansar hasta el [fecha]». Si pasan los días que Paco defina sin entrar ningún CFDI, aviso de posible fallo; durante el descanso no hay descargas ni avisos, y al reanudar el sistema se pone al día solo. El sistema también descansa.
- ✅ Respaldo cifrado programado en el servidor.
- ✅ Respaldo partido por RFC y año (1.7.0): desde la pantalla de Respaldos se genera manualmente un .faro por ejercicio y empresa, restaurable por partes con el restaurador de siempre.
- ✅ COPIA EXTERNA AUTOMÁTICA del respaldo (la copia en sí desde 1.6.4; la vigilancia de antigüedad desde 1.6.15): cada respaldo cifrado se copia solo a un segundo destino FUERA del NAS, con semáforo de antigüedad de la copia en Salud y alerta si lleva más de 7 días sin copia buena o si la copia falla — si el NAS muriera, el archivo fiscal no muere con él. **DESTINO DECIDIDO (Paco, 8 nov 2026): Google Drive, vía Cloud Sync nativo del NAS; la carpeta secundaria del respaldo vive dentro de la carpeta sincronizada (p. ej. «PacoSAT Respaldos»). A Drive solo llega el archivo CIFRADO.**

## 3. Listas negras (art. 69, 69-B y 69-B Bis)
- ✅ (Fuera de la app) Cruce manual de contrapartes contra los 16 listados oficiales guardados en ~/workspace/pacosat-listas-sat/, hecho el 8 nov 2026: todas las contrapartes con XML en el expediente salieron limpias. Dentro de la app, la vigilancia continua trabaja con el catálogo de 10 listados de la viñeta siguiente.
- ✅ Descarga automática y continua de los listados oficiales desde Datos Abiertos del SAT: 69-B y 69-B Bis desde el blob oficial del minisitio y los supuestos del art. 69 desde el paquete oficial del SAT en datos.gob.mx; los supuestos CSD sin efectos y Reducción art. 74 se cargan por archivo (sin CSV oficial verificado) y el motor los trata igual (1.6.13).
- ✅ Padrón de empresas a monitorear (clientes/proveedores): se puebla solo desde los CFDI; alta uno por uno y carga masiva por Excel o CSV (Nombre, RFC, Nota) leída en la propia app (1.6.13).
- ✅ Validador manual por RFC y por nombre/razón social (69, 69-B o ambas), en tiempo real contra todos los listados cargados (1.6.13).
- ✅ Alertas ante CUALQUIER transición (entradas, salidas, desvirtuados; también la línea base inicial) con la exposición por empresa (importes y CFDI en riesgo), alarma si un listado lleva >48 h sin actualizarse y panel «cómo voy» con semáforo por contraparte (1.6.13).
- ✅ Constancia de validación por empresa (fecha, listados consultados y resultado) como documento imprimible, listo para imprimir o guardar como PDF desde el diálogo de impresión (1.6.13).

## 4. e.firma y RFC que maneja
- ✅ Perfil de Mano Fil (MFI6212158B4) con su e.firma en la carpeta protegida del NAS. (Su e.firma caducó el 30-oct-2024: el perfil existe y sus archivos están en la carpeta protegida, pero no puede descargar del SAT hasta renovarla.)
- ✅ Subida de e.firma DESDE LA APP por RFC (.cer/.key + contraseña en pantalla), con validación inmediata de pareja, RFC y caducidad antes de guardar nada; queda en la carpeta protegida del servidor y se reactiva sola tras reiniciar; nunca a la base de datos ni a los respaldos (1.6.12).
- 🔄 Multi-RFC ampliado: Mano Fil, Elemental Denim (EDE1902136T2), el RFC personal de Paco y los de Rodrigo y José Javier — la arquitectura lo admite sin cambios desde la 1.4; cada perfil se activa cuando aporten su e.firma (la e.firma se coloca en persona, nunca por chat).

## 5. Constancias y opiniones (solo SAT)
- 🔄 Descarga mensual automática, activable por RFC, de la constancia de situación fiscal y la opinión de cumplimiento del SAT (1.6.14): el programador mensual, el archivo en Expedientes con fecha de emisión, el semáforo y las alertas están construidos y probados, y la subida manual del PDF funciona hoy y vale igual; la conexión con el portal del SAT (puerto `satDocFetch`) aún no está conectada en la instalación, así que la descarga automática queda registrada como intento fallido con su alerta hasta que se conecte ese puerto.
- ✅ Semáforo de vigencia (verde <60 días, ámbar 60–90, rojo >90) y alerta si una renovación falla o vence (1.6.14).
- 🔄 Envío por correo de la constancia/opinión recién descargada a uno o varios destinatarios (día, hora y destinatarios se configuran en la pantalla de Constancias): el envío sale automáticamente tras una descarga con éxito, así que depende de que el puerto de descarga del portal esté conectado (ver la primera viñeta de esta sección). No hay envío programado independiente de la descarga.

## 6. Salidas: reportes, impresión, exportaciones y correo
- ✅ Representación impresa del CFDI y paquete mensual básico para la contadora.
- ✅ Centro de reportes por periodo y contraparte, con la identidad de la app (pantalla «Salidas», imprimible y en CSV) (1.6.16).
- ✅ Impresión cuidada de las pantallas con reporte e impresión por lote de CFDI en un solo documento desde la selección de Facturas (1.6.16, sobre la representación completa de la 1.6.7).
- ✅ Exportaciones CSV con formato (reporte del mes, base DIOT con desglose) y programables vía los informes automáticos (1.6.16). (No se genera Excel/XLSX: el Excel solo se *lee* en la carga masiva del padrón de Listas.)
- ✅ EXPORTACIÓN COMPLETA LEGIBLE en un clic: todos los XML y PDF con su índice, en carpetas por RFC y año, sin depender del formato de respaldo — tus datos son tuyos y salen enteros cuando quieras (1.6.16).
- ✅ Comparativas AÑO CONTRA AÑO por contraparte: de un vistazo, quién te factura más que antes y qué gasto se está disparando (1.6.16).
- ✅ Correo DENTRO de la app: enviar CFDI, reportes y constancias con adjuntos del expediente, bitácora de envíos visible y botón de correo de prueba (el de prueba llegó en la 1.6.11) (1.6.16).
- ✅ Informe mensual AUTOMÁTICO a Nora: paquete del mes construido en el servidor (índice, XML, documentos, base DIOT con el desglose fiscal persistido, novedades de listas negras y PPD del mes), con día, hora y destinatarios configurables y envío manual inmediato (1.6.16).
- ✅ IVA DEL MES estimado por RFC (trasladado y acreditable desde el desglose; lo que no tiene desglose se señala para reprocesarlo, nunca se estima a ojo) y re-parseo histórico de los XML guardados sin contactar al SAT (1.6.16, mejora nº 6).
- ✅ CIERRE DE MES GUIADO: lista de comprobación paso a paso con semáforo por paso y acceso directo a donde se resuelve cada punto (1.6.16).
- ✅ Resumen semanal ejecutivo por correo (lunes): CFDI nuevos, solicitudes terminadas, cambios en listas y avisos de la semana, enlazado con la bitácora (1.6.16).

## 7. Dinero
- ✅ Conciliación bancaria CFDI ↔ movimientos: cruceta por importe y fecha con pagado/no pagado, pagos sin factura y facturas sin pago — desde CSV (1.6.17) o desde los estados archivados de Bancos (1.6.19).
- ✅ Cuentas por cobrar Y por pagar: relación pagos↔facturas persistida (los documentos relacionados de cada complemento de pago viajan en el desglose), saldos con antigüedad por contraparte y avisos al envejecer un PPD sin pago completo (30 días por pagar, 60 por cobrar) (1.6.17).
- ✅ Alerta ROJA de cancelación post-pago: CFDI cancelado que ya tenía pagos registrados escala el aviso del monitor y nombra el importe pagado; la pantalla Dinero los lista en rojo (1.6.17).
- ✅ Expediente 360 por contraparte: CFDI, pagos, saldos, situación en listas y documentos en una sola tarjeta (1.6.17).
- ✅ Detector de FACTURAS ESPERADAS: el proveedor recurrente (facturó en al menos 3 de los últimos 6 meses) que este mes no ha llegado genera aviso a partir del día 10 y aparece en Dinero (1.6.17).

## 7 bis. Bancos (apartado propio — entra en esta construcción por orden de Paco, 8 nov 22:46)
- ✅ Archivo de estados de cuenta por BANCO, CUENTA y MES: subes el estado (PDF) y queda guardado y ordenado, sin carpetas a mano; alta libre de bancos y cuentas con atajos para BBVA (cuenta y fondo), Santander (cheques y FONSER1) y Konfio (1.6.19).
- ✅ LECTURA AUTOMÁTICA de cada estado: saldos inicial/final, abonos y cargos y movimientos leídos del documento (formatos BBVA y Santander y genérico por etiquetas). Lo que no se lee con seguridad NO se inventa: el estado queda «a revisar» y se confirman las cifras a mano en la misma pantalla (1.6.19).
- ✅ CADENA DE SALDOS verificada mes a mes (el final de un mes = el inicial del siguiente; si no cuadra, semáforo rojo con la explicación de ambos importes) y SEMÁFORO DE FALTANTES por cuenta (1.6.19).
- ✅ POSICIÓN TOTAL: cuánto hay en cada banco y en total (cuentas y fondos), con su fecha — la foto bancaria completa en una pantalla (1.6.19).
- ✅ Es la base de la conciliación CFDI↔banco (sección 7): la pantalla Dinero consume los movimientos archivados con «Usar movimientos de Bancos» (1.6.19).

## 8. Cumplimiento
- ✅ Calendario fiscal por RFC (día 17 de provisionales y DIOT, anual del 31 de marzo, caducidad de la e.firma, constancias que cumplen 90 días y lo que captures a mano) con semáforo y aviso por correo 3 días antes (1.6.18).
- ✅ IVA del mes estimado por RFC (trasladado y acreditable desde el desglose persistido): la foto fiscal del mes antes de que la arme la contadora (1.6.16, en Salidas).
- ✅ Paquete de defensa por periodo en un clic: XML del mes con índice, validación de listas de cada contraparte y constancias/opiniones vigentes, listo para SAT o banco (1.6.18).
- ✅ Detector de errores y duplicados al revisar lo guardado: folio repetido con otro UUID, receptor que no es ningún perfil y totales que no cuadran con el desglose (1.6.18).
- ✅ Validador de RFC con estructura y fecha (al dar de alta un contribuyente).
- ✅ Reglas de clasificación automática por contraparte/concepto (la categoría se escribe en las facturas al aplicarlas) y aviso de ANOMALÍAS: importe inusual de un proveedor recurrente o posible duplicado aproximado (1.6.18).

## 9. Experiencia de uso
- ✅ Panel de salud (e.firma y su caducidad, correo, respaldos, vigilancia) y bitácora.
- ✅ Botón «PROBAR TODO» (1.7.0, en Operaciones): autodiagnóstico en un clic con un semáforo por prueba — base de datos, correo configurado, listados al día, respaldo y copia externa recientes y caducidad de cada e.firma. La conexión con el SAT NO se prueba a propósito: la disciplina 5002 prohíbe gastar solicitudes en diagnósticos.
- ✅ Bitácora de movimientos del sistema. ✅ CLICABLE (1.6.11): cada entrada abre el objeto al que se refiere (el CFDI de una cancelación, el SAT, los respaldos, el archivo). ✅ Filtros por tipo y texto, RESUMEN DE ACTIVIDAD por día y semana y exportación CSV (1.7.0, en Operaciones); ✅ registro de accesos del invitado y de su configuración (1.7.0, en Ajustes).
- ✅ Semáforos verde/ámbar/rojo en todo el sistema, con fila de semáforos abriendo el Resumen (1.6.11).
- ✅ Sonidos discretos configurables por evento (éxito, aviso, alerta, error) con interruptor general y elección por evento en Ajustes (cableados en 1.6.11).
- ✅ Click para abrir: cada tarjeta, fila, gráfico, periodo de cobertura y contraparte abre su documento o expediente (1.6.11).
- ✅ Acciones directas en tarjetas CFDI (ver, descargar XML, abrir PDF, copiar UUID, imprimir) y arrastrar y soltar para importar en cualquier pantalla; «Descargar ahora» por RFC; buscador global que también ejecuta acciones (1.6.11).
- ✅ PacoSAT instalable en el móvil (PWA) (1.7.0): manifiesto, icono y service worker que guarda la portada para abrir sin red; las pantallas ya eran adaptativas y la navegación funciona en pantallas pequeñas.
- ✅ MODO OFFLINE (1.7.0): la app abre sin conexión (portada en caché) y la pantalla «Sin conexión» consulta la copia local CIFRADA (AES-GCM con clave del dispositivo) y de solo lectura de los ÚLTIMOS 3 MESES (CFDI con su desglose, saldos por cobrar/pagar, facturas esperadas, antigüedad de listados y posición bancaria), siempre con el sello «estás viendo datos de las HH:MM». Los informes clave de esos 3 meses (resumen mensual e IVA estimado) se pregeneran en el servidor dentro del paquete sin conexión; la copia se refresca pulsando «Sincronizar ahora la copia sin conexión» en la pantalla «Sin conexión». Lo que no puede salir (la descarga de un RFC) queda EN COLA como intención y se ejecuta una sola vez al volver la conexión. El XML/PDF individual se abre offline si quedó en la caché reciente; el archivo histórico completo vive en el NAS.
- ✅ Acceso en casa sin internet (1.7.0): el mismo proxy del NAS puede servir un nombre local (o la IP) con idéntica autenticación — el procedimiento quedó documentado en DESPLIEGUE.md; sin red en absoluto, manda la copia sin conexión.
- ✅ Preguntas en lenguaje normal sobre los propios datos, calculadas 100 % en local (1.7.0, pantalla «Preguntas»): cuánto me deben, cuánto debo, el IVA estimado de un mes, qué vence esta semana y totales por RFC/periodo. Sin salir del dispositivo.
- ✅ Escala (1.7.0, mejora nº 10): sincronización por diferencias con revisión por registro y lápidas de borrado (la app solo copia lo que cambió), paginación del archivo de facturas (desde la 1.6.11) y cobertura calculada sobre índices en memoria.
- ✅ Sello en el pie: «PacoSAT {versión} · Modificado el {fecha} a las {hora} · Creado por Paco Iglesias» (la fecha de modificación la aporta el servidor y se omite en modo local sin servidor); en Ajustes, los mismos datos como ficha (versión, autor, creación y última modificación de la copia).

## 9 bis. Principios de experiencia (regla de diseño de Paco)
- ✅ INTUITIVO (aplicado en 1.6.11 y revisado en la 1.7.0): lenguaje llano; cada término del SAT explicado en una línea; botones con verbos claros («Descargar ahora», «Solicitar este hueco»); ninguna pantalla sin siguiente paso visible.
- ✅ PROACTIVO (pantalla «Hoy en PacoSAT» en 1.6.11 y revisión final en la 1.7.0): el sistema habla primero — pantalla de inicio «HOY EN PacoSAT» con el resumen del día, los pendientes con semáforo y el SIGUIENTE PASO sugerido; avisos antes de que las cosas venzan o se rompan, no después.
- ✅ AMIGABLE (aplicado en 1.6.11 y revisado en la 1.7.0): mensajes en tono cercano y claro; estados vacíos que enseñan qué hacer; errores que dicen qué pasó y cómo se arregla, sin códigos crípticos.
- ✅ ÚTIL (aplicado en 1.6.11 y revisado en la 1.7.0): cada pantalla termina en una acción posible; nada de información que no lleve a ninguna parte.

## 10. Seguridad y privacidad
- ✅ Todo corre en el NAS de Paco, tras su túnel y su contraseña; los datos no salen salvo al SAT (descargas con e.firma) y al correo que él configure.
- ✅ CSP estricta sin unsafe-inline (1.6.9): la política autoriza por huella SHA-256 los únicos bloques de estilo y script de la copia; el servidor calcula la misma política desde el archivo servido.
- ✅ La e.firma vive solo en la carpeta protegida; el SAT se contacta únicamente por el Web Service oficial, con disciplina 5002.
- ✅ Acceso invitado de SOLO LECTURA (1.7.0): credencial separada (entrada por /invitado), el servidor rechaza cualquier escritura, desactivado por defecto, con bitácora de accesos, consultas e intentos bloqueados visible en Ajustes.

## Fuera de alcance (decidido por Paco)
- Timbrar CFDI (se timbra en Más Facturas). Buzón tributario con CIEC. Opinión del IMSS (solo SAT).

## Cierre del proyecto
- ✅ **VERSIÓN ACTUAL: 1.7.1** — la 1.7.0 se fusionó (PR #24, commit 6486841) y se desplegó en el NAS el 9 nov 2026; la 1.7.1 suma el blindaje anti-5002 (PR #25) y el arreglo de la preparación del almacenamiento en Safari (PR #26), fusionada el 9 nov 2026 y con el despliegue al NAS a continuación. Pendientes del cierre: la prueba del SAT de ventana corta (una sola vez), el examen de Paco (entrar y agregar el RFC sin ningún aviso, repetido tras el arreglo de Safari) y la prueba de restauración del respaldo.
