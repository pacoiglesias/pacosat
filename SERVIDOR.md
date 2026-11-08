# Faro Fiscal en un servidor privado

El servicio puede mantenerse encendido en un servidor Linux aunque apagues tu computadora. Esta edición usa una sola instancia con SQLite en un volumen persistente. Los expedientes, XML y PDF del modo servidor se comparten entre dispositivos autorizados. La configuración incluida requiere Docker Compose, un dominio que apunte al servidor y HTTPS. El acceso web de esta plantilla es de operador único.

1. Extrae el ZIP en el servidor. Copia `servidor.env.example` como `.env` y completa el dominio, el usuario, el hash de una contraseña fuerte generado con `caddy hash-password`, y una clave aleatoria hexadecimal de 64 caracteres. Deja el hash entre comillas simples.
2. Crea `faro-secrets` fuera del control de versiones. Copia `servidor-config.example.json` a `faro-secrets/config.json`, reemplaza el ejemplo por cada RFC autorizado y coloca los archivos .cer y .key en ese directorio. Completa SMTP si quieres avisos, o elimina la propiedad `mail`. Protege ese directorio con permisos restringidos. El proceso de Faro usa el UID 1000 y necesita permiso de lectura. Utiliza almacenamiento cifrado o un gestor de secretos para montar la configuración.
3. Arranca con `docker compose up -d --build`. Caddy publica el acceso autenticado por HTTPS. El puerto interno de Faro no se publica. El DNS y los puertos 80 y 443 deben permitir emitir el certificado de Caddy. Restringe el acceso con VPN o una política de red cuando corresponda.
4. Entra por HTTPS, abre Centro SAT y comprueba que el RFC aparezca activo. Verifica una solicitud corta y un aviso real antes de dejarlo operativo. El proceso de descarga no requiere que el navegador permanezca abierto.
5. Si migras desde Windows, crea un respaldo cifrado en la versión local y restáuralo desde el panel web. Mantén además un respaldo del volumen del servidor. Detén Faro antes de copiar su base SQLite y evita ejecutar dos instancias contra el mismo volumen.

Los secretos de arranque se vuelven a cargar al reiniciar el servidor. El botón Pausar de la interfaz afecta la sesión actual. Para desactivar de forma permanente un RFC o el correo, retira su entrada de la configuración protegida y reinicia. La automatización desatendida cubre CFDI. Constancias, opiniones y declaraciones pueden archivarse y visualizarse en el expediente.

La plantilla de despliegue requiere validación en el servidor objetivo. El servicio no se ha desplegado y el SAT y el SMTP real aún requieren una prueba con tus credenciales, introducidas directamente en el entorno autorizado.
