# Faro Fiscal para Windows

1. Para instalar y arrancar, sigue los pasos de **Inicio en Windows** del [README](README.md): extrae todo el ZIP en una carpeta, instala Node.js 24 o superior y ejecuta **Iniciar-Faro.cmd**. La primera ejecución instala los componentes del SAT y de correo desde npm con las versiones fijadas del repositorio.
2. Si el navegador no se abre solo, entra en **http://127.0.0.1:43729/** desde Chrome o Edge.
3. Agrega un contribuyente. En **Centro SAT → Configurar RFC**, selecciona la e.firma de ese RFC y el intervalo.
4. Para avisos, usa **Centro SAT → Configurar SMTP**. La conexión se verifica al guardar y los avisos se envían para CFDI recibidos detectados como nuevos.
5. Mantén abierto el servicio de Faro. Puedes cerrar la pestaña. El servicio sigue consultando, descargando y enviando avisos mientras Windows está activo y hay internet. Al volver a abrir la pestaña, incorpora los paquetes pendientes en la vista de facturas. Al detener y reiniciar el servicio hay que volver a autorizar e.firma y SMTP. Los datos de estas sesiones se mantienen en memoria.

## Expedientes

En **Todos los RFC**, la importación clasifica por emisor y receptor. Al seleccionar un RFC concreto, los archivos ajenos quedan en **Por revisar**, con el motivo y los RFC detectados. **Abrir XML** permite inspeccionar archivos importados o no importados. Las facturas se muestran por fecha de emisión descendente y admiten filtros por mes, dirección y texto.

Faro archiva PDF de constancias, cédulas, opiniones, declaraciones y acuses. Esta edición automatiza la descarga de CFDI. La obtención desatendida de esos otros trámites queda pendiente.

## Datos

El servicio local escucha solo en 127.0.0.1. Los expedientes y XML importados se guardan en el perfil de Chrome o Edge. La cola SAT y los paquetes pendientes quedan en %LOCALAPPDATA%\FaroFiscalLocal. Las copias cifradas exportadas desde la sección Respaldos contienen expedientes y archivos, sin e.firma, SMTP ni cola SAT. Para migrar desde Faro HTML, exporta un respaldo en esa edición y restáuralo en esta. Abre Faro siempre con el mismo navegador y perfil. Los avisos incluyen el RFC y conteo, sin adjuntar archivos.

## Validación

Las pruebas locales de cola y correo emplean servicios simulados. Para validar la conexión real, autoriza un RFC directamente en el programa, solicita un periodo corto con CFDI y verifica que el paquete aparezca en Facturas CFDI. Las solicitudes pueden permanecer pendientes mientras el SAT procesa el paquete.
Usa Factura PDF para leer su folio, asignarlo a un RFC y vincularlo con el XML. Los PDF escaneados pueden requerir que captures el folio a mano. Puedes abrir el PDF desde Expedientes y PDF o desde el detalle del XML. Para trabajar con la computadora apagada, consulta SERVIDOR.md.
En Vigilancia SAT, Faro revisa periódicamente el estado de los CFDI y coteja el RFC emisor con el listado oficial 69-B. Distingue Vigente, Cancelado, No encontrado y Sin consulta. Si hay SMTP configurado, envía un aviso por cada UUID detectado como cancelado. En Windows, abre la interfaz tras importar para registrar los CFDI en el servicio de vigilancia. Las revisiones posteriores continúan mientras el servicio esté abierto.
