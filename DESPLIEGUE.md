# Despliegue de PacoSAT en el NAS

**Última modificación: 12 nov 2026, 04:45 CST (ronda final 1.27.0)**

**Nombre público (decisión de Paco, 8 nov 2026):** el acceso es **https://pacosat.iglesiasmurrieta.com** en todo: `PACOSAT_DOMAIN=pacosat.iglesiasmurrieta.com` en el compose del NAS, el túnel de Cloudflare y cualquier enlace que la app ponga en sus correos salen de ese nombre. El nombre anterior, `sat.iglesiasmurrieta.com`, queda como **alias con redirección** al nuevo durante la transición (se mantiene el registro DNS y una regla de redirección en el túnel/proxy hasta que Paco diga retirarlo). El cambio de túnel/DNS se hace en el despliegue final; el código no contiene el nombre (llega por `PACOSAT_ORIGIN`)— solo esta documentación y los ejemplos lo fijan.

La vía PRINCIPAL de despliegue es descargar la imagen ya construida: al fusionar a `main`, GitHub Actions construye la imagen y la publica en GHCR como `ghcr.io/pacoiglesias/pacosat:<versión>` (y `:latest`). El NAS no compila nada: descarga y recrea. La configuración y los secretos viven SOLO en el NAS (carpeta `pacosat-secrets` y variables del compose desplegado); GitHub nunca entra al NAS.

## compose principal (por imagen)

```yaml
services:
  pacosat:
    image: ghcr.io/pacoiglesias/pacosat:latest   # o la etiqueta de la versión, p. ej. :1.27.0
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

1. Comprobar que la fusión a `main` terminó y que el workflow «Publicar imagen Docker en GHCR» quedó en verde (la etiqueta de la versión existe en GHCR).
2. En el NAS, en la carpeta del proyecto: `docker compose pull pacosat && docker compose up -d pacosat`.
3. Verificar la app: responde tras el túnel, el pie muestra «PacoSAT {versión} · Modificado el {fecha} a las {hora}» con la versión nueva y su hora, y el panel de salud lee los perfiles.
4. Limpieza (convención del NAS): borrar las imágenes `ghcr.io/pacoiglesias/pacosat` de versiones anteriores que ya no use ningún contenedor (`docker image prune` acotado a esa imagen) y reportar lo borrado. Nunca se borra lo vivo: `.env`, `pacosat-secrets`, respaldos, el compose desplegado, los volúmenes ni los datos.

## Notas de la ronda final 1.27.0 (leer antes de desplegarla)

- **El destino del respaldo debe ser REAL en el host (pendiente arrastrado de la 1.23.0):** el respaldo programado escribe en `PACOSAT_BACKUP_DIR` si la variable existe; si no, en el `backup.dir` del `config.json`; si no, en la carpeta `respaldos` junto a la base (dentro del volumen de datos). En el despliegue vivo esa carpeta del host (`respaldos/` del proyecto) quedó VACÍA y el compose desplegado no traía el montaje que la nota de la 1.23.0 daba por puesto: antes de que Paco fije su contraseña de respaldo, el despliegue de la 1.27.0 debe dejar el destino montado desde el host (bind mount de `./respaldos` sobre el destino que la configuración use) y VERIFICAR en el host que el primer conjunto cae ahí — si cayera solo en la capa del contenedor o en el volumen equivocado, se perdería al recrearlo o no lo vería Cloud Sync.
- **Diario WAL de la base:** la base corre en WAL con `synchronous=FULL`; el archivo `-wal` puede crecer entre reinicios (en producción se observaron ~35 MB: es mantenimiento, no corrupción). Desde la 1.27.0 cada instantánea de respaldo/exportación hace `wal_checkpoint(TRUNCATE)` antes de copiar, así que ningún respaldo pierde lo último escrito. No se borran a mano los archivos `-wal`/`-shm` con el contenedor en marcha; un reinicio normal lo recoge.
- **Login propio:** al subir a la 1.27.0 las sesiones del login propio anteriores quedan invalidadas UNA vez (desde esta ronda cada sesión lleva la huella de la credencial con la que nació, y cambiar la contraseña las invalida todas): Paco entra de nuevo y ya. El freno de intentos fallidos ahora vive en el estado del servidor, no en memoria.
- **Llave VAPID del push:** vive en `vapid.json` (0600) dentro de `PACOSAT_EFIRMA_DIR` (la carpeta de secretos), ya no en la base; al primer arranque de la 1.27.0 migra sola desde el ajuste heredado y lo deja limpio. Nada que hacer a mano; solo no borrar ese archivo al limpiar la carpeta de secretos.

## Respaldo: construir en el NAS (vía anterior)

Si GHCR no está disponible, el compose del repo conserva la vía de construcción local comentada: se descomenta `build: .` (y se retira o se deja `image:`, que entonces nombra la imagen construida) y se despliega con `docker compose up -d --build pacosat`. Es la vía lenta que este documento deja como respaldo.

## Copia externa del respaldo: Google Drive (decisión de Paco, 8 nov 2026)

El respaldo programado de PacoSAT escribe, además de la copia principal, una copia en el destino secundario (`secondaryDir`). En el despliegue del NAS, esa carpeta secundaria debe vivir DENTRO de la carpeta que Cloud Sync (el sincronizador nativo del Synology) mantiene sincronizada con la carpeta «PacoSAT Respaldos» de Google Drive. A Drive solo sube el archivo `.faro` CIFRADO (el respaldo nunca contiene la e.firma ni credenciales SMTP): Cloud Sync es solo el transporte, sin cambios en la app. El panel de Salud vigila la antigüedad de la copia externa y la app alerta si lleva más de 7 días sin una copia buena o si una copia falla (ronda 1.6.15/1.6.16).

## Acceso por la red local (sin internet ni túnel)

PacoSAT también debe poder abrirse desde casa por la red local del NAS, con la misma autenticación, cuando no haya internet o el túnel de Cloudflare esté caído. El diseño completo (nombre local y mismo proxy Caddy sirviendo en LAN) se documenta con la ronda 1.7.0 (modo offline); la regla es que la credencial y la clave de proxy son las mismas que en la vía pública y que nada de la configuración sale del NAS.

Concretamente (1.7.0): el mismo Caddy que atiende `pacosat.iglesiasmurrieta.com` puede servir además un nombre local (por ejemplo `pacosat.lan`) o la IP del NAS con el mismo bloque de proxy inverso hacia el contenedor: la app recibe idénticas cabeceras (`X-PacoSAT-Proxy`), la sesión y la autenticación no cambian, y la PWA instalada abre igual por esa vía. En el `config.json` del NAS, `origin` debe ser la dirección pública; el acceso LAN funciona porque el proxy reenvía el mismo origen interno al contenedor. Si no hay red en absoluto, la copia sin conexión de la app (pantalla «Sin conexión») permite consultar los últimos 3 meses desde el propio dispositivo.

## Acceso invitado de solo lectura (1.7.0)

La app admite una credencial de invitado, separada y DESACTIVADA por defecto: se activa en Ajustes (interruptor + contraseña propia) y la entrada es la misma dirección con `/invitado` al final. El invitado solo puede leer (el servidor rechaza cualquier cambio) y cada entrada, consulta e intento queda en la bitácora de accesos, visible en Ajustes. No hay nada que configurar en el NAS: vive en el estado del servidor, no en secretos.
