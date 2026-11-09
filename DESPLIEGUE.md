# Despliegue de PacoSAT en el NAS

**Última modificación: 8 nov 2026, 23:05 CST**

**Nombre público (decisión de Paco, 8 nov 2026):** el acceso es **https://pacosat.iglesiasmurrieta.com** en todo: `PACOSAT_DOMAIN=pacosat.iglesiasmurrieta.com` en el compose del NAS, el túnel de Cloudflare y cualquier enlace que la app ponga en sus correos salen de ese nombre. El nombre anterior, `sat.iglesiasmurrieta.com`, queda como **alias con redirección** al nuevo durante la transición (se mantiene el registro DNS y una regla de redirección en el túnel/proxy hasta que Paco diga retirarlo). El cambio de túnel/DNS se hace en el despliegue final; el código no contiene el nombre (llega por `PACOSAT_ORIGIN`)— solo esta documentación y los ejemplos lo fijan.

La vía PRINCIPAL de despliegue es descargar la imagen ya construida: al fusionar a `main`, GitHub Actions construye la imagen y la publica en GHCR como `ghcr.io/pacoiglesias/pacosat:<versión>` (y `:latest`). El NAS no compila nada: descarga y recrea. La configuración y los secretos viven SOLO en el NAS (carpeta `pacosat-secrets` y variables del compose desplegado); GitHub nunca entra al NAS.

## compose principal (por imagen)

```yaml
services:
  pacosat:
    image: ghcr.io/pacoiglesias/pacosat:latest   # o la etiqueta de la versión, p. ej. :1.7.0
    restart: unless-stopped
    environment:
      PACOSAT_ORIGIN: https://${PACOSAT_DOMAIN:?Configura PACOSAT_DOMAIN}
      PACOSAT_PROXY_KEY: ${PACOSAT_PROXY_KEY:?Configura PACOSAT_PROXY_KEY}
      PACOSAT_DATA_DIR: /var/lib/pacosat
      PACOSAT_STARTUP_CONFIG: /run/pacosat-secrets/config.json
    volumes:
      - pacosat-data:/var/lib/pacosat
      - ./pacosat-secrets:/run/pacosat-secrets:ro
  # El servicio `proxy` (Caddy) y los volúmenes no cambian: ver compose.yml del repo.
```

El paquete GHCR debe ser público (o el NAS debe iniciar sesión en GHCR con un token de solo lectura) para que `docker compose pull` funcione sin pasos extra.

## Actualizar a una versión nueva

1. Comprobar que la fusión a `main` terminó y que el workflow «Publicar imagen Docker en GHCR» quedó en verde (la etiqueta de la versión existe en GHCR).
2. En el NAS, en la carpeta del proyecto: `docker compose pull pacosat && docker compose up -d pacosat`.
3. Verificar la app: responde tras el túnel, el pie muestra «PacoSAT {versión} · Modificado el {fecha} a las {hora}» con la versión nueva y su hora, y el panel de salud lee los perfiles.
4. Limpieza (convención del NAS): borrar las imágenes `ghcr.io/pacoiglesias/pacosat` de versiones anteriores que ya no use ningún contenedor (`docker image prune` acotado a esa imagen) y reportar lo borrado. Nunca se borra lo vivo: `.env`, `pacosat-secrets`, respaldos, el compose desplegado, los volúmenes ni los datos.

## Respaldo: construir en el NAS (vía anterior)

Si GHCR no está disponible, el compose del repo conserva la vía de construcción local comentada: se descomenta `build: .` (y se retira o se deja `image:`, que entonces nombra la imagen construida) y se despliega con `docker compose up -d --build pacosat`. Es la vía lenta que este documento deja como respaldo.

## Copia externa del respaldo: Google Drive (decisión de Paco, 8 nov 2026)

El respaldo programado de PacoSAT escribe, además de la copia principal, una copia en el destino secundario (`secondaryDir`). En el despliegue del NAS, esa carpeta secundaria debe vivir DENTRO de la carpeta que Cloud Sync (el sincronizador nativo del Synology) mantiene sincronizada con la carpeta «PacoSAT Respaldos» de Google Drive. A Drive solo sube el archivo `.faro` CIFRADO (el respaldo nunca contiene la e.firma ni credenciales SMTP): Cloud Sync es solo el transporte, sin cambios en la app. El panel de Salud vigila la antigüedad de la copia externa y la app alerta si lleva más de 7 días sin una copia buena o si una copia falla (ronda 1.6.15/1.6.16).

## Acceso por la red local (sin internet ni túnel)

PacoSAT también debe poder abrirse desde casa por la red local del NAS, con la misma autenticación, cuando no haya internet o el túnel de Cloudflare esté caído. El diseño completo (nombre local y mismo proxy Caddy sirviendo en LAN) se documenta con la ronda 1.7.0 (modo offline); la regla es que la credencial y la clave de proxy son las mismas que en la vía pública y que nada de la configuración sale del NAS.
