# PacoSAT — Qué incluye (documento vivo)

**Última modificación: 8 nov 2026, 22:34 CST**

Estados: ✅ incluido y verificado · 🔄 en construcción (cadena de rondas en marcha) · 📋 planificado en la cadena.
Este documento es la FUENTE del listado de capacidades: la app lo muestra dentro (pantalla «Qué incluye PacoSAT») y se actualiza en cada ronda y cada despliegue, junto con el sello de versión y hora de creación.

## 1. Núcleo CFDI
- ✅ Importación de XML y ZIP con validación, y vinculación de PDF.
- ✅ Visor CFDI profesional: datos completos, conceptos e impuestos, cadena original, Timbre Fiscal, complemento de Pagos 2.0 y representación impresa.
- ✅ Conciliación PDF ↔ XML.
- ✅ Línea de tiempo por CFDI y buscador global.
- ✅ Mapa de cobertura por periodos y gráfica de estados.
- 🔄 Persistencia del desglose fiscal al importar (subtotal, IVA por tasa, IEPS, retenciones, método/forma de pago, uso CFDI, tipo de cambio, serie/folio) con re-parseo histórico: base de la DIOT.
- 🔄 Detector de errores y duplicados al importar (UUID/folio repetido, RFC receptor equivocado, totales que no cuadran).

## 2. Descarga y vigilancia del SAT
- ✅ Descarga masiva oficial por Web Service con e.firma (SDK), por RFC y dirección (emitidos/recibidos), con paquetes ZIP.
- ✅ Perfiles multi-RFC con cadencia propia (Mano Fil: cada 360 min, ventana 7 días, ambas direcciones).
- ✅ Vigilancia de estado de cada CFDI cada 24 h y de cancelaciones.
- ✅ Escudo de criterios 5002 (registro de criterios ya enviados; nunca repetir un criterio idéntico).
- ✅ Solicitudes Metadata (hasta 1.000.000 de registros ligeros por petición) para reconciliar cobertura (1.6.10): automáticas una al día por RFC y a petición por periodo; los CFDI que el SAT conoce y faltan en XML se listan en Cobertura.
- ✅ Recibidos SIN filtro de «solo vigentes», registrando el estado inicial de cada CFDI (1.6.10): el conector ya no envía filtro de estado y el estado inicial llega de los metadatos al detalle del CFDI.
- 🔄 Blindaje: intención registrada ANTES de enviar («presunto enviado» al arrancar), base de datos con synchronous=FULL a prueba de cortes, timeout duro de 60 s en llamadas al SAT con vigilante del ciclo, y contador de descargas por paquete con tope 5008 y estado terminal claro.
- ✅ Carpeta vigilada recursiva: todo CFDI que caiga en la carpeta entra solo.
- ✅ Solicitudes frecuentes EN UN CLIC (1.6.10) («mes pasado completo», «este trimestre», «este año») sin teclear fechas: menos errores y menos criterios 5002 quemados por un dedo mal puesto.
- ✅ AVISO DE SILENCIO **CONFIGURABLE** + MODO DESCANSO CON **INTERRUPTOR ON/OFF** (petición expresa de Paco: visual, práctico e intuitivo): un interruptor grande y visible — general en la pantalla «Hoy» y uno por RFC — para encender/apagar la vigilancia en un toque, con el estado siempre claro («Vigilando» / «Descansando») y opción de «descansar hasta el [fecha]». Si pasan los días que Paco defina sin entrar ningún CFDI, aviso de posible fallo; durante el descanso no hay descargas ni avisos, y al reanudar el sistema se pone al día solo. El sistema también descansa.
- ✅ Respaldo cifrado programado. 🔄 Respaldo partido por RFC y año, sin techo de 100 MB.
- 🔄 COPIA EXTERNA AUTOMÁTICA del respaldo: cada respaldo cifrado se copia solo a un segundo destino FUERA del NAS, con semáforo de antigüedad de la copia — si el NAS muriera, el archivo fiscal no muere con él. **DESTINO DECIDIDO (Paco, 8 nov 2026): Google Drive, vía Cloud Sync nativo del NAS; la carpeta secundaria del respaldo vive dentro de la carpeta sincronizada (p. ej. «PacoSAT Respaldos»). A Drive solo llega el archivo CIFRADO.**

## 3. Listas negras (art. 69, 69-B y 69-B Bis)
- ✅ Hoy (manual, ya verificado): cruce de contrapartes contra los 16 listados oficiales guardados en ~/workspace/pacosat-listas-sat/.
- 🔄 Descarga automática y continua de los listados oficiales desde Datos Abiertos del SAT.
- 🔄 Padrón de empresas a monitorear (clientes/proveedores): se puebla solo desde los CFDI y los pagos; alta uno por uno y carga masiva por Excel (Nombre, RFC, Nota).
- 🔄 Validador manual por RFC y por nombre/razón social (69, 69-B o ambas), en tiempo real.
- 🔄 Alertas ante CUALQUIER transición (entradas, salidas, desvirtuados; también la línea base inicial) con la exposición por empresa (importes y CFDI en riesgo), alarma si un listado lleva >48 h sin actualizarse y panel «cómo voy» con semáforo por contraparte.
- 🔄 Constancia de validación en PDF por empresa (fecha, listados consultados y resultado).

## 4. e.firma y RFC que maneja
- ✅ Perfil de Mano Fil (MFI6212158B4) con su e.firma en la carpeta protegida del NAS.
- 🔄 Subida de e.firma DESDE LA APP por RFC (.cer/.key + contraseña en pantalla), con validación inmediata de pareja, RFC y caducidad; nunca a la base de datos ni a los respaldos.
- 🔄 Multi-RFC ampliado: Mano Fil, Elemental Denim (EDE1902136T2), el RFC personal de Paco y los de Rodrigo y José Javier — cada uno con su perfil y su e.firma cuando la aporten.

## 5. Constancias y opiniones (solo SAT)
- 🔄 Descarga mensual automática, activable por RFC, de la constancia de situación fiscal y la opinión de cumplimiento del SAT, archivadas en Expedientes con fecha de emisión.
- 🔄 Semáforo de vigencia (verde <60 días, ámbar 60–90, rojo >90) y alerta si una renovación falla o vence.
- 🔄 Envío automático por correo a uno o varios destinatarios, con día y hora programables en pantalla clara.

## 6. Salidas: reportes, impresión, exportaciones y correo
- ✅ Representación impresa del CFDI y paquete mensual básico para la contadora.
- 🔄 Centro de reportes PDF por periodo, contraparte o concepto, con la identidad de la app.
- 🔄 Impresión cuidada de todas las pantallas e impresión por lote de CFDI en un solo PDF.
- 🔄 Exportaciones Excel/CSV con formato, también programables.
- 🔄 EXPORTACIÓN COMPLETA LEGIBLE en un clic: todos los XML y PDF con su índice, en carpetas por RFC y año, sin depender del formato de respaldo — tus datos son tuyos y salen enteros cuando quieras.
- 🔄 Comparativas AÑO CONTRA AÑO por contraparte y en total: de un vistazo, quién te factura más que antes y qué gasto se está disparando.
- 🔄 Correo DENTRO de la app: enviar CFDI, reportes y constancias con plantillas, bitácora de envíos y botón de correo de prueba.
- 🔄 Informe mensual AUTOMÁTICO a Nora: paquete del mes, base DIOT con desglose, novedades de listas negras y cuentas por cobrar.
- 🔄 CIERRE DE MES GUIADO: asistente paso a paso (descargar → conciliar → listas → informe a Nora → respaldo) con semáforo por paso: el mes se cierra siguiendo la lista, sin olvidar nada.
- 🔄 Resumen semanal ejecutivo por correo (lunes): la foto de la semana — CFDI nuevos, cancelaciones, por cobrar/pagar y próximos vencimientos.

## 7. Dinero
- 🔄 Conciliación bancaria automática CFDI ↔ estados de cuenta (BBVA/Santander): pagado/no pagado, pagos sin factura y facturas sin pago.
- 🔄 Cuentas por cobrar: relación pagos↔facturas persistida, vista «por cobrar» con antigüedad por contraparte.
- 🔄 Alerta ROJA de cancelación post-pago: CFDI recibido cancelado después de pagado, con el pago vinculado.
- 🔄 Expediente 360 por contraparte: CFDI, pagos, saldos, listas negras y constancias en una sola tarjeta.
- 🔄 Cuentas por PAGAR con vencimientos: lo que debes a proveedores (recibidos PPD sin pago), con antigüedad y avisos antes de que venza.
- 🔄 Detector de facturas ESPERADAS que no llegaron: si un proveedor recurrente (renta, servicios, igualas) no ha timbrado este mes lo de siempre, aviso — la factura que falta también es un problema.

## 8. Cumplimiento
- 🔄 Calendario fiscal por RFC (DIOT, provisionales, anual, caducidades de e.firma/CSD y de constancias) con semáforo y avisos por correo.
- 🔄 IVA del mes estimado por RFC (trasladado y acreditable desde el desglose persistido): la foto fiscal del mes antes de que la arme la contadora.
- 🔄 Paquete de defensa por periodo en un clic: CFDI con índice, constancias de validación y opiniones, listo para SAT o banco.
- ✅ Validador de RFC con estructura y fecha (al dar de alta un contribuyente).
- 🔄 Reglas de clasificación automática por contraparte/concepto (categoría y deducibilidad editables por Paco) y aviso de ANOMALÍAS: importe inusual de un proveedor recurrente o posible duplicado aproximado.

## 9. Experiencia de uso
- ✅ Panel de salud (e.firma y su caducidad, correo, respaldos, vigilancia) y bitácora.
- 🔄 Botón «PROBAR TODO»: autodiagnóstico completo en un clic (e.firma válida, correo operativo, listas al día, respaldo reciente, SAT alcanzable) con un semáforo por prueba.
- ✅ Bitácora básica de movimientos del sistema. 🔄 BITÁCORA COMPLETA Y CLICABLE: cada entrada (descarga, verificación, alerta, respaldo, correo, acceso) abre el objeto al que se refiere; filtros por tipo, RFC y resultado; y RESUMEN DE ACTIVIDAD — qué hizo el sistema solo, por día y por semana — consultable y exportable.
- 🔄 Semáforos verde/ámbar/rojo en todo el sistema, con fila de semáforos abriendo el Resumen.
- 🔄 Sonidos discretos configurables por evento (éxito, aviso, alerta, error) con interruptor y volumen en Ajustes.
- 🔄 Click para abrir: cada tarjeta, fila, gráfico, periodo de cobertura y contraparte abre su documento o expediente; los correos de alerta llevan enlace.
- 🔄 Acciones directas en tarjetas CFDI (ver, descargar XML, abrir PDF, copiar UUID, imprimir) y arrastrar y soltar para importar en cualquier pantalla; «Descargar ahora» por RFC; buscador global que también ejecuta acciones.
- 🔄 PacoSAT instalable en el móvil (PWA) con pantallas adaptadas.
- 🔄 MODO OFFLINE: la app abre sin conexión y permite CONSULTAR una copia local cifrada de solo lectura con los datos de los ÚLTIMOS 3 MESES (CFDI con su desglose, estados, por cobrar/pagar, listas negras), con la hora de la última sincronización siempre visible («estás viendo datos de las HH:MM»); en cada conexión se dejan además PREGENERADOS los informes clave de esos 3 meses (resumen mensual, IVA estimado, por cobrar/pagar) para abrirlos o imprimirlos offline. Lo que no puede salir (descargas y consultas al SAT) queda en cola y se ejecuta al volver la conexión. El XML/PDF individual se abre offline si quedó en la caché reciente; el archivo histórico completo vive en el NAS.
- 🔄 Acceso en casa sin internet: además del nombre público, PacoSAT responde en la red local del NAS con la misma contraseña, para cuando se caiga internet o el túnel.
- 🔄 Preguntas en lenguaje normal sobre los propios datos, calculadas 100 % en local (sin salir del NAS).
- 🔄 Escala: sincronización por diferencias, paginación y caché de cobertura para miles de CFDI.
- ✅/🔄 Sello en el pie y en Ajustes: «PacoSAT {versión} · Modificado el {fecha} a las {hora}» + «Creado por Paco Iglesias» — mantenido y verificado en CADA despliegue.

## 9 bis. Principios de experiencia (regla de diseño de Paco)
- 🔄 INTUITIVO: lenguaje llano; cada término del SAT explicado en una línea; botones con verbos claros («Descargar ahora», «Solicitar este hueco»); ninguna pantalla sin siguiente paso visible.
- 🔄 PROACTIVO: el sistema habla primero — pantalla de inicio «HOY EN PacoSAT» con el resumen del día, los pendientes con semáforo y el SIGUIENTE PASO sugerido; avisos antes de que las cosas venzan o se rompan, no después.
- 🔄 AMIGABLE: mensajes en tono cercano y claro; estados vacíos que enseñan qué hacer; errores que dicen qué pasó y cómo se arregla, sin códigos crípticos.
- 🔄 ÚTIL: cada pantalla termina en una acción posible; nada de información que no lleve a ninguna parte.

## 10. Seguridad y privacidad
- ✅ Todo corre en el NAS de Paco, tras su túnel y su contraseña; los datos no salen salvo al SAT (descargas con e.firma) y al correo que él configure.
- ✅ CSP estricta sin unsafe-inline (1.6.9): la política autoriza por huella SHA-256 los únicos bloques de estilo y script de la copia; el servidor calcula la misma política desde el archivo servido.
- ✅ La e.firma vive solo en la carpeta protegida; el SAT se contacta únicamente por el Web Service oficial, con disciplina 5002.
- 🔄 Acceso invitado de SOLO LECTURA (pensado para la contadora): credencial separada, sin capacidad de cambiar ni descargar masivamente, desactivado por defecto y con registro de accesos.

## Fuera de alcance (decidido por Paco)
- Timbrar CFDI (se timbra en Más Facturas). Buzón tributario con CIEC. Opinión del IMSS (solo SAT).

## Cierre del proyecto
- 📋 **VERSIÓN FINAL A ENTREGAR: 1.7.0** — despliegue conjunto final al NAS con todo lo construido, prueba del SAT de ventana corta (una sola vez) y examen de Paco: entrar y agregar el RFC sin ningún aviso.
