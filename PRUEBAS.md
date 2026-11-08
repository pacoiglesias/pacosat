# Prueba piloto

1. Ejecuta `npm run check`. Debe terminar sin errores.
2. Inicia PacoSAT y agrega un RFC propio autorizado.
3. Importa un XML de ese RFC: debe aparecer con su UUID, importe y detalle; volver a importarlo debe marcar duplicado.
4. Importa un XML ajeno: debe indicar RFC emisor/receptor y motivo de rechazo.
5. Archiva una factura PDF y vincúlala desde Operaciones. Un UUID de otro RFC debe rechazarse. Recarga y verifica persistencia.
6. Crea un respaldo cifrado. Comprueba una restauración en un perfil de navegador de prueba, nunca sobre tu único expediente.
7. Autoriza e.firma en Centro SAT y solicita siete días. Revisa estados, errores y paquetes. El SAT puede tardar en liberar los resultados.
8. Verifica un CFDI conocido vigente y uno cancelado; compara UUID y resultado con el SAT. No interpretes Sin consulta como Vigente.
9. Configura SMTP y comprueba un aviso por nuevos CFDI; repite la descarga y verifica que no se duplique.
10. Para nube: configura HTTPS y acceso privado; prueba rechazo sin autenticación y reinicio del servicio. Apaga la PC y confirma nuevas descargas en el servidor.
11. En modo servidor, deja un XML válido, un ZIP con CFDI y un archivo dañado en la carpeta vigilada: en el siguiente ciclo los dos primeros deben importarse y moverse a `procesados/AAAA-MM-DD`, el dañado a `errores` y llegar un aviso por correo; la importación queda en la bitácora.
12. Activa el respaldo programado: al vencimiento debe aparecer `PacoSAT-AAAA-MM-DD.faro` en la carpeta indicada y debe poder restaurarse con la contraseña del respaldo usando la interfaz; con la carpeta inaccesible debe llegar el aviso de fallo.
13. En el navegador: cambia entre modo claro y oscuro, desactiva el sonido y recarga (la preferencia persiste), genera el reporte mensual e imprímelo a PDF, y exporta la base DIOT en CSV para compararla con los totales del Resumen.
14. Blindaje 5002: solicita un periodo ya solicitado y comprueba que PacoSAT avisa antes de enviar («última disponible»), que al confirmar se envía una vez más y que el tercer intento queda bloqueado ofreciendo mover el inicio 1 segundo; la solicitud nueva debe mostrar el estado de su criterio en «Solicitudes recientes».

Registra fecha, RFC de prueba, resultado esperado/obtenido y error. No publiques credenciales ni comprobantes en issues del repositorio público.
