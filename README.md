# PacoSAT · satfacturas

Versión 1.6.7 para pruebas controladas. Aplicación propia sin Firebase para organizar CFDI y documentos de varios RFC.
La instancia en modo servidor se publica tras un proxy HTTPS con autenticación; consulta [SERVIDOR.md](SERVIDOR.md).

## Inicio en Windows

1. Instala Node.js 24 LTS.
2. Descarga el repositorio y descomprime todos los archivos.
3. Ejecuta `Iniciar-PacoSAT.cmd`. La instalación inicial requiere internet.
4. Agrega un RFC, importa un XML y abre **Operaciones y alertas**.
5. Configura e.firma únicamente dentro de tu instalación, en **Centro SAT**.

También puedes ejecutar `npm install --ignore-scripts`, `npm run check` y `npm start`.
Abre http://127.0.0.1:43729. Abrir solo el HTML no activa el servicio SAT.

## Funciones

- XML y ZIP: validación de RFC, UUID, duplicados, motivos de rechazo y visor.
- Alta de contribuyentes con **validador completo de RFC**: estructura, fecha embebida y dígito verificador oficial del SAT, con aviso al momento. Es una validación de forma (no confirma que el RFC exista en el SAT); si el dígito no cuadra avisa de la probable errata y solo guarda con confirmación expresa, y los RFC genéricos del SAT (XAXX010101000 y XEXX010101000) se aceptan con nota, sin exigirles el dígito.
- PDF: lectura de candidatos UUID, visor y conciliación manual con XML del mismo RFC.
- Descarga de CFDI mediante e.firma, cola de solicitudes y programación por RFC.
- **Blindaje contra el error 5002 del SAT**: libro permanente de criterios ya solicitados (RFC, sentido, tipo, filtros y ventana exacta al segundo). Antes de enviar, PacoSAT avisa si el criterio ya se solicitó una vez — repetirlo gasta la última disponible — y bloquea la tercera, ofreciendo mover el inicio un segundo; la descarga programada se auto-corrige igual y lo anota en la bitácora, y si el SAT devuelve un 5002 al verificar, el criterio queda marcado como agotado con aviso por correo. Cada solicitud muestra su estado de criterio: disponible, última disponible o agotado. El error 5002 y su límite «con el mismo criterio» son oficiales del SAT; la cifra de dos solicitudes por criterio es el criterio de la comunidad técnica (PhpCfdi), no una cifra publicada por el SAT.
- Consulta de estado SAT, seguimiento de cancelaciones y categorías del listado 69-B.
- Correo mediante SMTP configurado por el propietario.
- Avisos por correo cuando un RFC del expediente aparece nuevo en el listado 69-B, cuando la descarga automática falla de forma persistente y cuando una solicitud al SAT queda vencida, fallida o rechazada.
- Totales por RFC y mes en el Resumen (emitidos y recibidos, conteos e importes), con exportación CSV, y contador de novedades desde la última visita.
- Bitácora «Actividad reciente» en el Resumen: importaciones, descargas del SAT, respaldos, PDF archivados o vinculados y cancelaciones detectadas, con fecha y hora.
- Resumen con indicadores clave (CFDI vigentes y cancelados según la vigilancia, importe del mes, descargas en curso y última actividad) y gráfico de barras de totales por mes, emitidos contra recibidos.
- Modo oscuro completo además del claro (sigue al sistema o se fija desde la cabecera) y juego propio de iconos SVG en navegación, acciones y estados.
- Sonidos breves sintetizados (éxito, error y aviso nuevo) con interruptor visible y persistente en la cabecera; solo suenan tras la primera interacción con la página.
- Reporte mensual por RFC listo para imprimir o guardar en PDF desde el navegador: totales y conteos por contribuyente, más cancelados y coincidencias 69-B del mes según la última vigilancia.
- **Base para la DIOT**: vista y CSV con totales por RFC proveedor y mes desde los CFDI recibidos. Es base de trabajo para la contadora, no la declaración (el importador no guarda el desglose de IVA).
- Archivo de CFDI con filtro por estado SAT (vigente, cancelado, con 69-B o sin consulta).
- En modo servidor: **carpeta vigilada** que importa sola todo XML/ZIP/PDF que reciba, recorriendo también las subcarpetas. La ingesta es prudente: espera a que cada archivo deje de crecer antes de leerlo, rechaza por tamaño sin cargar el contenido y distingue tres resultados — procesado (a `procesados` conservando su ruta), procesado con incidencias (un ZIP parcialmente válido, a `incidencias` con el desglose por archivo en la bitácora y en el aviso) y rechazado (a `errores` con aviso por correo).
- **Respaldo completo y recuperable**: el respaldo programado (diario o semanal, mismo formato .faro cifrado que el manual) incluye además el **estado operativo** — cola de descargas, libro de criterios 5002 y agotados, avisos pendientes y estado de la vigilancia — en una sección versionada dentro del mismo archivo, tomada en la misma foto que el expediente; admite un **destino secundario** con el mismo cifrado (una carpeta sincronizada fuera del NAS) y una **prueba de restauración** que descifra y valida el respaldo más reciente sin tocar los datos activos, ejecutable a demanda y automática tras cada respaldo, con registro en la bitácora. Ni la e.firma ni las credenciales SMTP viajan en el respaldo. El límite de 100 MB del formato se aplica al conjunto (archivos + estado); el diseño prevé partir en un respaldo por RFC y año si un expediente lo supera.
- **Cobertura de descarga por RFC**: vista con el «verificado hasta» por RFC y sentido, los huecos entre tramos descargados (las costuras de ±1 s del blindaje marcadas como micro-huecos) y un mapa de calor anual de días cubiertos; los huecos nuevos se anotan en la bitácora y PacoSAT nunca solicita un tramo por su cuenta. La verificación de solicitudes pendientes reintenta con espera creciente (5, 10, 20, 40 y hasta 60 minutos) en lugar del ritmo fijo anterior.
- **Anillo de estados** en el Resumen: donut con vigentes, cancelados, con 69-B y sin consulta según la vigilancia (los mismos datos del filtro por estado del archivo), con leyenda y conteos.
- **Salud del sistema** en Operaciones: por perfil, la **caducidad real de la e.firma** (se lee la fecha notAfter del certificado al desbloquearla y se guarda; si nunca se leyó, dice «sin dato») con cuenta atrás en días y **avisos por correo a 90, 60 y 30 días** y al vencer, una sola vez por umbral y certificado; última descarga con éxito por perfil, último respaldo con sus destinos y su prueba de restauración, y el tamaño del expediente en conteos.
- **Historia de un CFDI**: el detalle de cada comprobante muestra su línea de tiempo solo con datos guardados — emisión, descargas del SAT que lo incluyeron, consultas de estado, aviso de cancelación y PDF vinculado —; lo que no tenga histórico no aparece.
- **Buscador global** en la cabecera: por UUID completo o parcial, folio fiscal o RFC; lleva al archivo con el filtro aplicado y abre el detalle si hay un único resultado. Atajo Ctrl/Cmd+K.
- **Paquete mensual para la contadora**: desde los totales, un ZIP por RFC y mes (`PacoSAT-<RFC>-<AAAA-MM>.zip`) con totales en CSV, base DIOT del mes en CSV, resumen imprimible en HTML y manifiesto con el contenido y la fecha. Solo se descarga; no se envía a nadie automáticamente.
- Estados de carga con esqueletos sobrios en el Resumen y en Cobertura mientras llegan los datos (compatibles con modo oscuro y con «reducir movimiento»).
- **Ajustes de identidad** (vista «Ajustes»): nombre de la instalación en la cabecera, el reporte mensual y el manifiesto del paquete; **logo opcional** (PNG/JPG/SVG seguro, hasta 200 KB, validado por su contenido real) guardado en el servidor; **color de acento** con 7 opciones de la paleta del sistema de diseño (contraste AA en claro y oscuro) más el predeterminado; y **nombre del remitente** para los correos del sistema. Los ajustes viven **en el servidor** (su base de datos, junto al estado operativo): sobreviven a reinicios y redespliegues, viajan en el respaldo completo y se restauran con él — nunca en pacosat-secrets.
- **Versión y sellos visibles**: un pie discreto en todas las pantallas («PacoSAT {versión} · Modificado el {fecha} a las {hora}») y el bloque «Acerca de» en Ajustes con la versión, la fecha de creación del software (primer commit del repositorio) y el inicio de la instancia en modo servidor. Los sellos salen de datos reales (la generación y el archivo servido), nunca de datos tecleados.
- El intervalo de descarga de un perfil admite **cualquier valor entre 60 y 1440 minutos** tanto en la API como en el archivo de arranque (la cadencia de revisión de CFDI nuevos es de 360 minutos, cada 6 horas).
- **Visor CFDI profesional**: el detalle de cada comprobante muestra la representación completa parseada de su XML — cabecera (versión, serie y folio, fecha, lugar de expedición, tipo, forma y método de pago, moneda, certificado, uso de CFDI), emisor y receptor completos (régimen y domicilio fiscal), tabla de conceptos con sus impuestos, totales con desglose (traslados por impuesto y tasa, retenciones), el Timbre Fiscal Digital entero (UUID, PAC, certificados y los sellos y la cadena original en secciones plegables con botón de copiar), el complemento de Pagos 2.0 con sus documentos relacionados y cualquier otro complemento detectado por nombre. Incluye el estado en el SAT según la vigilancia, la historia del comprobante, copiar el UUID con un clic, descargar el XML, abrir el PDF vinculado (o el aviso de que no hay ninguno) y una **representación impresa tipo factura** con la identidad de Ajustes y los sellos en letra pequeña. La tarjeta resumen se queda como cabecera del detalle y en los listados.
- Respaldo cifrado de expedientes y restauración.
- Modo servidor con SQLite, proxy HTTPS y configuración privada; consulta [SERVIDOR.md](SERVIDOR.md).

## Alcance y pruebas

Lee [AUDITORIA.md](AUDITORIA.md) y [PRUEBAS.md](PRUEBAS.md) antes de usar datos reales.
Las pruebas automáticas simulan SAT y SMTP. No acreditan una conexión real ni una auditoría externa.
Constancias, opiniones y declaraciones se archivan como PDF: no se recuperan automáticamente en esta versión.
No incluye OCR ni usuarios con roles separados. El servidor está pensado para un propietario de confianza.
Para funcionar con la PC apagada necesita un servidor encendido y configurado; GitHub no aloja el proceso SAT.

## Desarrollo

Edita los archivos `.part` y ejecuta `npm run build`; `Faro-Fiscal.html` y `xml-core.mjs` son generados.
GitHub Actions ejecuta las pruebas en Node.js 24 y verifica que los archivos generados estén actualizados.
El repositorio incluye `package-lock.json`, generado con una instalación real verificada: usa `npm ci` para reproducir el entorno exacto. La imagen Docker y `Iniciar-PacoSAT.cmd` también instalan con `npm ci`.

## Datos privados

Este repositorio es público. Nunca subas e.firmas, contraseñas, XML, PDF, respaldos ni bases de datos.
Los ejemplos contienen marcadores; las credenciales se configuran fuera del repositorio.
GitHub conserva el código, no respalda los expedientes ni la cola de ejecución.
