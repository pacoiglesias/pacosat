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

Registra fecha, RFC de prueba, resultado esperado/obtenido y error. No publiques credenciales ni comprobantes en issues del repositorio público.
