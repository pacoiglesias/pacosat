# Faro Fiscal · satfacturas

Versión 1.3.0 para pruebas controladas. Aplicación propia sin Firebase para organizar CFDI y documentos de varios RFC.

## Inicio en Windows

1. Instala Node.js 24 LTS.
2. Descarga el repositorio y descomprime todos los archivos.
3. Ejecuta `Iniciar-Faro.cmd`. La instalación inicial requiere internet.
4. Agrega un RFC, importa un XML y abre **Operaciones y alertas**.
5. Configura e.firma únicamente dentro de tu instalación, en **Centro SAT**.

También puedes ejecutar `npm install --ignore-scripts`, `npm run check` y `npm start`.
Abre http://127.0.0.1:43729. Abrir solo el HTML no activa el servicio SAT.

## Funciones

- XML y ZIP: validación de RFC, UUID, duplicados, motivos de rechazo y visor.
- PDF: lectura de candidatos UUID, visor y conciliación manual con XML del mismo RFC.
- Descarga de CFDI mediante e.firma, cola de solicitudes y programación por RFC.
- Consulta de estado SAT, seguimiento de cancelaciones y categorías del listado 69-B.
- Correo mediante SMTP configurado por el propietario.
- Bitácora «Actividad reciente» en el Resumen: importaciones, descargas del SAT, respaldos, PDF archivados o vinculados y cancelaciones detectadas, con fecha y hora.
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
El repositorio incluye `package-lock.json`, generado con una instalación real verificada: usa `npm ci` para reproducir el entorno exacto. La imagen Docker y `Iniciar-Faro.cmd` también instalan con `npm ci`.

## Datos privados

Este repositorio es público. Nunca subas e.firmas, contraseñas, XML, PDF, respaldos ni bases de datos.
Los ejemplos contienen marcadores; las credenciales se configuran fuera del repositorio.
GitHub conserva el código, no respalda los expedientes ni la cola de ejecución.
