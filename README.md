# PacoSAT · satfacturas

Versión 1.6.3 para pruebas controladas. Aplicación propia sin Firebase para organizar CFDI y documentos de varios RFC.
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
- En modo servidor: **carpeta vigilada** que importa sola todo XML/ZIP/PDF que reciba, recorriendo también las subcarpetas (los válidos pasan a `procesados` conservando su ruta, los fallidos a `errores` con aviso por correo) y **respaldo cifrado programado** diario o semanal con formato idéntico al manual, con aviso por correo si falla.
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
