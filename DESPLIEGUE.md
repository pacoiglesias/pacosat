# Despliegue de PacoSAT en el NAS

**Última modificación: 12 nov 2026, 09:04 CST (ronda 1.28.0 «Paquete de mejoras»)**

**Nombre público (decisión de Paco, 8 nov 2026):** el acceso es **https://pacosat.iglesiasmurrieta.com** en todo: `PACOSAT_DOMAIN=pacosat.iglesiasmurrieta.com` en el compose del NAS, el túnel de Cloudflare y cualquier enlace que la app ponga en sus correos salen de ese nombre. El nombre anterior, `sat.iglesiasmurrieta.com`, queda como **alias con redirección** al nuevo durante la transición (se mantiene el registro DNS y una regla de redirección en el túnel/proxy hasta que Paco diga retirarlo). El cambio de túnel/DNS se hace en el despliegue final; el código no contiene el nombre (llega por `PACOSAT_ORIGIN`)— solo esta documentación y los ejemplos lo fijan.

La vía PRINCIPAL de despliegue es descargar la imagen ya construida: al fusionar a `main`, GitHub Actions construye la imagen y la publica en GHCR como `ghcr.io/pacoiglesias/pacosat:<versión>` (y `:latest`). El NAS no compila nada: descarga y recrea. La configuración y los secretos viven SOLO en el NAS (carpeta `pacosat-secrets` y variables del compose desplegado); GitHub nunca entra al NAS.

## compose principal (por imagen)

```yaml
services:
  pacosat:
    image: ghcr.io/pacoiglesias/pacosat:latest   # o la etiqueta de la versión, p. ej. :1.28.0
    restart: unless-stopped
    environment:
      PACOSAT_ORIGIN: https://${PACOSAT_DOMAIN:?Configura PACOSAT_DOMAIN}
      PACOSAT_PROXY_KEY: ${PACOSAT_PROXY_KEY:?Configura PACOSAT_PROXY_KEY}
      PACOSAT_DATA_DIR: /var/lib/pacosat
      PACOSAT_STARTUP_CONFIG: /run/pacosat-secrets/config.json
      PACOSAT_EFIRMA_DIR: /run/pacosat-secrets/efirma
    volumes:
      - pacosat-data:/var/lib/pacosat
      - ./pacosat-secrets:/run/pacosat-secrets
  # El servicio `proxy` (Caddy) y los volúmenes no cambian: ver compose.yml del repo.
```

El paquete GHCR debe ser público (o el NAS debe iniciar sesión en GHCR con un token de solo lectura) para que `docker compose pull` funcione sin pasos extra.

## e.firma subida desde la app (1.6.12)

Con «Subir e.firma» (Centro SAT), Paco guarda el .cer/.key y la contraseña de cada RFC **desde la propia app**: el servidor lo valida todo antes de escribir (RFC del certificado, caducidad, pareja llave/contraseña) y deja los archivos en la carpeta que diga `PACOSAT_EFIRMA_DIR` — en este despliegue, `pacosat-secrets/efirma`, por eso el volumen de secretos se monta **sin `:ro`** — con permisos 0600, y los reactiva solo en cada arranque. Esa carpeta nunca entra en la base de datos, en los respaldos ni en las exportaciones: vive y muere en el NAS. Sin la variable, la carpeta por defecto es `efirma/` junto a la base de datos (dentro del volumen de datos). Los perfiles del `config.json` de arranque siguen funcionando igual que antes; si un RFC está en ambos sitios, manda el subido desde la app.

## Actualizar a una versión nueva

1. Comprobar que la fusión a `main` terminó y que el workflow «Publicar imagen Docker en GHCR» quedó en verde: en GHCR existen la etiqueta de la versión (`:<versión>`) y la del merge (`:sha-<sha>`), y **ambas apuntan al mismo digest** (se anota el digest: es la huella que manda en la verificación).
2. En el NAS, en la carpeta del proyecto: `docker compose pull pacosat && docker compose up -d pacosat`.
3. Verificar la app: responde tras el túnel, el pie muestra «PacoSAT {versión} · Modificado el {fecha} a las {hora}» con la versión nueva y su hora, y el panel de salud lee los perfiles. Y verificar la IMAGEN por su **digest**, no solo por la etiqueta de versión (que es mutable: republicar la sobrescribe): `docker compose images pacosat` (o `docker image inspect`) debe enseñar para el contenedor recreado el MISMO digest anotado en el paso 1 para las etiquetas `:<versión>` y `:sha-<sha>`. Si el digest no coincide, lo desplegado no es lo fusionado: no se da por bueno el despliegue.
4. Limpieza (convención del NAS): borrar las imágenes `ghcr.io/pacoiglesias/pacosat` de versiones anteriores que ya no use ningún contenedor (`docker image prune` acotado a esa imagen) y reportar lo borrado. Nunca se borra lo vivo: `.env`, `pacosat-secrets`, respaldos, el compose desplegado, los volúmenes ni los datos.

## Notas de la ronda final 1.27.0 (leer antes de desplegarla)

- **El destino del respaldo debe ser REAL en el host (pendiente arrastrado de la 1.23.0):** el respaldo programado escribe en `PACOSAT_BACKUP_DIR` si la variable existe; si no, en el `backup.dir` del `config.json`; si no, en la carpeta `respaldos` junto a la base (dentro del volumen de datos). En el despliegue vivo esa carpeta del host (`respaldos/` del proyecto) quedó VACÍA y el compose desplegado no traía el montaje que la nota de la 1.23.0 daba por puesto: antes de que Paco fije su contraseña de respaldo, el despliegue de la 1.27.0 debe dejar el destino montado desde el host (bind mount de `./respaldos` sobre el destino que la configuración use) y VERIFICAR en el host que el primer conjunto cae ahí — si cayera solo en la capa del contenedor o en el volumen equivocado, se perdería al recrearlo o no lo vería Cloud Sync.
- **Diario WAL de la base:** la base corre en WAL con `synchronous=FULL`; el archivo `-wal` puede crecer entre reinicios (en producción se observaron ~35 MB: es mantenimiento, no corrupción). Desde la 1.27.0 cada instantánea de respaldo/exportación hace `wal_checkpoint(TRUNCATE)` antes de copiar, así que ningún respaldo pierde lo último escrito. No se borran a mano los archivos `-wal`/`-shm` con el contenedor en marcha; un reinicio normal lo recoge.
- **Login propio:** al subir a la 1.27.0 las sesiones del login propio anteriores quedan invalidadas UNA vez (desde esta ronda cada sesión lleva la huella de la credencial con la que nació, y cambiar la contraseña las invalida todas): Paco entra de nuevo y ya. El freno de intentos fallidos ahora vive en el estado del servidor, no en memoria.
- **Llave VAPID del push:** vive en `vapid.json` (0600) dentro de `PACOSAT_EFIRMA_DIR` (la carpeta de secretos), ya no en la base; al primer arranque de la 1.27.0 migra sola desde el ajuste heredado y lo deja limpio. Nada que hacer a mano; solo no borrar ese archivo al limpiar la carpeta de secretos.

## Notas de la ronda 1.28.0 «Paquete de mejoras» (leer antes de desplegarla)

- **Migraciones amables al arrancar, nada a mano:** la ronda añade la columna `origen` a los cuatro diarios de corridas (sat_doc_runs, ciec_runs, decl_runs, trib_runs) y la tabla `audit_events` del Registro. Todo nace solo en el primer arranque con la base existente; no hay paso manual ni se toca ningún dato.
- **El `.dockerignore` del paquete es contrato de construcción, como siempre:** la ronda añade UNA parte diferida nueva (`registro-ui.part`, la pantalla del Registro) que entra en el paquete por la lista de `build.mjs`/Dockerfile; si la imagen se construyera sin ella, la pantalla del Registro no cargaría y la suite ronda1280 lo caza antes. Verificar tras el despliegue que GET /parte/registro responde 200 tras la puerta del proxy.
- **La cadencia semanal del Buzón Tributario corre sola desde el primer tick:** no hay ajuste nuevo que fijar. Lo que SÍ hay que esperar de ella: su primera corrida automática (y la manual que Paco lance) traerá la página del fallo verificada y el inventario de enlaces del portal — la navegación del buzón y de declaraciones se adapta en la ronda siguiente CONTRA esa pantalla real, no a ciegas. Esta ronda no promete arreglar las descargas: promete que ningún fallo vuelve a quedar mudo ni sin evidencia.
- **Verificación viva tras desplegar (la de siempre, contra la superficie real):** el pie enseña 1.28.0; el menú enseña Declaraciones y Registro (13 destinos); Hoy no dice «Todo en orden» si hay avisos abiertos; la pantalla del Buzón Tributario dice la fecha de su próxima consulta automática; el Registro lista lo de hoy con la corrida del buzón de las 08:22 como fallo con su motivo.

## Notas de la ronda 1.29.0 — GHCR activo y ejecutor local (leer antes de desplegarla)

- **GHCR ACTIVO desde esta ronda (decisión de Paco, 12 nov 15:13):** la vía principal es la imagen preconstruida. El paquete incluye `.github/workflows/ghcr.yml`: al fusionar a `main` (y a mano con workflow_dispatch) construye y publica `ghcr.io/pacoiglesias/pacosat` con TRES etiquetas — la versión de `package.json` (`:1.29.0`), `:latest` y `:sha-<sha del merge>` — para linux/amd64 y linux/arm64. El NAS solo hace `docker compose pull` y recrea; la variante `build:` del compose queda como respaldo documentado (sección «Respaldo: construir en el NAS»), no como vía principal. Lo vivo del NAS manda en lo adaptado (su compose desplegado, sus secretos y sus montajes no se machacan: solo cambia la etiqueta que se descarga).
- **Cómo se verifica que la imagen desplegada ES la versión fusionada:** (1) en GHCR, la etiqueta `:1.29.0` y la `:sha-<sha>` del merge apuntan al mismo digest; (2) en el NAS, tras el pull, `docker compose images pacosat` (o `docker image inspect`) enseña ese mismo digest para el contenedor recreado; (3) la app en vivo enseña 1.29.0 en su pie y el paquete dentro de la imagen (`package.json`) dice 1.29.0. La verificación del despliegue de la 1.29 está diseñada para esta vía: pull → recrear → versión/digest comprobados → conteos de producción (registros, avisos, cfdi_watch, mail_sends, alerts) contra los de antes del despliegue. Sin compilación en el NAS en ningún paso.
- **Vuelta atrás con el respaldo local:** la imagen anterior queda en el NAS tras el pull (Docker no la borra sola): para revertir, se fija la etiqueta anterior en el compose desplegado (p. ej. `:1.28.0`, cuyo digest también consta en GHCR) y se recrea; si GHCR no respondiera, la vía `build:` del compose construye desde el repo en la rama `release/<versión anterior>`. La base de datos no se toca en la vuelta atrás: las migraciones de la 1.29.0 son aditivas y la 1.28.0 las ignora.
- **Si el conector de GitHub no tuviera permiso de Workflows al empujar:** el archivo queda preparado en el repo y el único gesto pendiente es de Paco (autorizar el workflow en GitHub); el resto de la cadena no se bloquea por eso — el despliegue puede hacerse una vez por la vía `build:` mientras tanto, declarándolo.

## Notas de la ronda 1.29.0 — ejecutor local (leer antes de desplegarla)

- **La ejecución contra el SAT cambia de sitio:** desde esta ronda el proceso del NAS arranca en modo remoto (`executorMode: 'remote'` fijado en el propio código): Buzón Tributario y Declaraciones ya NO navegan desde el NAS; encolan trabajos para el ejecutor del equipo de Paco. Sin ejecutor en línea los trabajos quedan «esperando tu equipo» (visibles en el panel del ejecutor de la pantalla Buzón Tributario y en el Registro como acción pendiente, nunca como fallo). La descarga de CFDI por CIEC y constancia/opinión no cambian en esta ronda.
- **Migraciones amables al arrancar, nada a mano:** columnas nuevas en `trib_notifications` (categoria, archivada, archivadaEn, enPapelera, papeleraEn), tabla `trib_tombstones` (lápidas de la papelera), tablas `sat_executors`, `sat_executor_jobs` y `sat_executor_attempts`, y columnas `verificada`/`ejecutorJobId` en `declaraciones`. Todo aditivo e idempotente sobre la base existente.
- **El ejecutor, en el equipo de Paco:** el paquete incluye `ejecutor-local.mjs` (raíz). Se configura por entorno (`PACOSAT_URL`, `PACOSAT_EXECUTOR_TOKEN`, `PACOSAT_EFIRMA_DIR`, `PACOSAT_CHROMIUM_PATH`) y se empareja una vez desde la app (Buzón Tributario → panel «Ejecutor local del SAT» → «Emparejar un ejecutor en mi equipo»): el token se enseña UNA vez y en el NAS solo queda su huella SHA-256. La e.firma vive en el equipo de Paco (`PACOSAT_EFIRMA_DIR` local, misma disposición que la carpeta protegida de la app); jamás viaja en trabajos ni en trazas.
- **Comprobación de verdad tras el despliegue (la de esta ronda):** con el ejecutor corriendo en el equipo de Paco y su gesto único (su contraseña de e.firma la primera vez, tecleada por él en su equipo), Mano Fil, un solo mes: el trabajo vuelve con el PDF correcto, el mes se marca con su número de operación verificado, y el Buzón lista si hay mensajes sin abrir ninguno. Hasta que esa corrida viva pase, la navegación del ejecutor contra el portal real se declara NO probada (ver el informe de la ronda).
- **Verificación viva tras desplegar:** el pie enseña 1.29.0; el menú enseña los grupos La mañana / El dinero / El SAT y los papeles / La casa con «Centro SAT»; la barra inferior móvil es Hoy · Avisos · Buzón · Dinero · Más; el Buzón Tributario enseña el panel del ejecutor y su Papelera; Pagos abre con su tarjeta de vencimientos; Totales por RFC y mes se ordena por años y cada mes se entra hasta sus CFDI.

## Respaldo: construir en el NAS (vía anterior)

Si GHCR no está disponible, el compose del repo conserva la vía de construcción local comentada: se descomenta `build: .` (y se retira o se deja `image:`, que entonces nombra la imagen construida) y se despliega con `docker compose up -d --build pacosat`. Es la vía lenta que este documento deja como respaldo.

## Copia externa del respaldo: Google Drive (decisión de Paco, 8 nov 2026)

El respaldo programado de PacoSAT escribe, además de la copia principal, una copia en el destino secundario (`secondaryDir`). En el despliegue del NAS, esa carpeta secundaria debe vivir DENTRO de la carpeta que Cloud Sync (el sincronizador nativo del Synology) mantiene sincronizada con la carpeta «PacoSAT Respaldos» de Google Drive. A Drive solo sube el archivo `.faro` CIFRADO (el respaldo nunca contiene la e.firma ni credenciales SMTP): Cloud Sync es solo el transporte, sin cambios en la app. El panel de Salud vigila la antigüedad de la copia externa y la app alerta si lleva más de 7 días sin una copia buena o si una copia falla (ronda 1.6.15/1.6.16).

## Acceso por la red local (sin internet ni túnel)

PacoSAT también debe poder abrirse desde casa por la red local del NAS, con la misma autenticación, cuando no haya internet o el túnel de Cloudflare esté caído. El diseño completo (nombre local y mismo proxy Caddy sirviendo en LAN) se documenta con la ronda 1.7.0 (modo offline); la regla es que la credencial y la clave de proxy son las mismas que en la vía pública y que nada de la configuración sale del NAS.

Concretamente (1.7.0): el mismo Caddy que atiende `pacosat.iglesiasmurrieta.com` puede servir además un nombre local (por ejemplo `pacosat.lan`) o la IP del NAS con el mismo bloque de proxy inverso hacia el contenedor: la app recibe idénticas cabeceras (`X-PacoSAT-Proxy`), la sesión y la autenticación no cambian, y la PWA instalada abre igual por esa vía. En el `config.json` del NAS, `origin` debe ser la dirección pública; el acceso LAN funciona porque el proxy reenvía el mismo origen interno al contenedor. Si no hay red en absoluto, la copia sin conexión de la app (pantalla «Sin conexión») permite consultar los últimos 3 meses desde el propio dispositivo.

## Acceso invitado de solo lectura (1.7.0)

La app admite una credencial de invitado, separada y DESACTIVADA por defecto: se activa en Ajustes (interruptor + contraseña propia) y la entrada es la misma dirección con `/invitado` al final. El invitado solo puede leer (el servidor rechaza cualquier cambio) y cada entrada, consulta e intento queda en la bitácora de accesos, visible en Ajustes. No hay nada que configurar en el NAS: vive en el estado del servidor, no en secretos.
