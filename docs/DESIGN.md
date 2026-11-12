# PacoSAT · Sistema de diseño

La fuente de verdad visual de PacoSAT. Nació en la Ronda Visual
(1.26.0), que cerró el sistema de tokens: desde entonces, ninguna
regla nueva de CSS escribe un color, un radio o una sombra a mano —
todo sale de un token de `style.part`, y este documento dice cuáles
son y cuándo se usa cada uno. La suite (`verify.cjs`,
`ronda1260.test.mjs`) pina lo esencial: si un cambio rompe una regla
de aquí, la batería lo caza antes de que llegue a Paco.

## Principios (los de Paco)

1. **Cada pantalla, un solo trabajo.** Hoy manda: es el centro de
   mando — qué pasa, qué es urgente, qué gesto hace falta — y el
   resto de pantallas hace una cosa cada una, con la jerarquía
   clara y lo importante primero.
2. **El mismo dato, una sola vez por pantalla.** Repetir una cifra
   o un nombre dos veces en la misma vista es un error de diseño
   (regla cazada en Bolsas y aplicada aquí: el Buzón enseñaba el
   importe dos veces por fila; el héroe de Hoy repetía el RFC que
   ya dicen el selector y la ceja).
3. **Todo problema lleva semáforo:** de quién es (de Paco, del SAT
   o del sistema), qué significa y el único gesto que hace falta —
   o «nada: se resuelve solo».
4. **Lo frecuente, en uno o dos toques.** Confirmaciones que se ven
   donde está el dedo (avisos flotantes), objetivos táctiles
   uniformes, y ningún estado que cambie en silencio: si Dinero no
   puede refrescar con el servidor, la pantalla lo dice.
5. **Nada decorativo que estorbe.** El movimiento es breve y con
   propósito; la gráfica enseña el dato que la pantalla resume.

## Tokens de color

Definidos en `:root` de `style.part` con `light-dark()`: cada token
lleva su valor claro y su valor oscuro; el modo oscuro es una
pulida del mismo sistema, no un tema aparte.

| Token | Uso |
|---|---|
| `--green` | La marca: acciones primarias, activo, acento elegido |
| `--green-hover` | Hover de la marca |
| `--on-accent` | Texto sobre la marca |
| `--tint` | Fondo suave de la marca (pastillas, pestañas activas) |
| `--accent-ink` | **Tinta de marca** sobre `--tint`: insignias, pestañas, pasos, el activo de la barra inferior |
| `--ok-ink` | **Semáforo «bien»**: SOLO significado (vigente, al día, hecho) |
| `--ok-bg` | Fondo del semáforo «bien» |
| `--warn-ink` / `--warn-bg` | Semáforo «ojo»: vence, falta, caduca |
| `--danger` / `--danger-ink` / `--danger-bg` | Semáforo «mal»: error, vencido, cancelado |
| `--ink` / `--muted` | Texto y texto secundario |
| `--bg` / `--surface` / `--surface-2` | Fondo, tarjetas, fondos suaves |
| `--line` / `--border` (`--bd`) | Bordes |
| `--nav-bg` / `--nav-ink` | Barra lateral |
| `--nav-active-bg` / `--nav-active-ink` | Destino activo en la barra lateral |
| `--chart-2` | Segunda serie de las gráficas |
| `--focus` | Anillo de foco visible |

### Marca ≠ semáforo (la regla de la 1.26.0)

Antes de la 1.26.0, elegir un acento (burdeos, violeta…) redefinía
`--ok-ink`: el verde de «todo bien» cambiaba con la marca y el
semáforo mentía. Desde la ronda, **los bloques de acento solo
definen tokens de marca** (`--green`, `--green-hover`,
`--on-accent`, `--tint`, `--accent-ink` y los de navegación);
`--ok-ink` es del semáforo y ningún acento lo toca. `verify.cjs`
comprueba el contraste AA de la tinta de marca sobre el tinte en
los 7 acentos × claro/oscuro.

### Colores fugados: prohibidos

Ninguna regla escribe `rgba(...)` ni un hex suelto para pintar un
estado: se deriva del token con `color-mix(in srgb, var(--danger)
8%, transparent)` y compañía. Los únicos hex que quedan en la hoja
son los de los propios tokens, los del papel impreso (negro sobre
blanco, deliberado) y los fondos profundos del héroe y la entrada.

## Espaciado, radios, sombras, tipo

- **Espaciado:** `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16
  · `--sp-5` 24 px. Los rellenos históricos de paneles y tarjetas
  (12/16/24) ya viven en esa escala.
- **Radios:** `--r-s` 8 (controles, chips) · `--r-m` 12 (tarjetas
  pequeñas, logo, avisos flotantes) · `--r-l` 14 (paneles,
  diálogos, héroe) · `--r-pill` 100 (pastillas). Ningún radio nuevo
  fuera de la escala.
- **Sombras:** `--shadow-1` (diálogos, tarjeta de entrada) y
  `--shadow-2` (avisos flotantes). Nada más proyecta sombra.
- **Tipo:** la escala cerrada es 11 (mínimo funcional; el texto del
  mapa de calor subió de 9 a 11 en la ronda) · 12 · 13 · 14 · 15
  (`--fs-xs/--fs-s/--fs-b` nombran los tres primeros peldaños) ·
  16 · 18 · 22 · 24 · 30. Sin medios píxeles (12.5/13.5 fuera) y
  sin pesos que la fuente no tiene (650/750 quedan solo donde ya
  estaban; lo nuevo usa 400/600/700).

## Componentes

- **Panel** (`.panel`): una tarjeta, un trabajo. Título y una frase
  que dice qué se ve; dentro, primero la señal (pastillas de
  estado), después el detalle.
- **Pastilla de estado** (`statusPill`): ok/warn/bad/dim con su
  punto; el color es siempre del semáforo, nunca de la marca.
- **Aviso flotante** (`.toast-card`): espejo visible de la barra
  `#status` (que sigue siendo el registro). Vive abajo a la
  derecha en escritorio y sobre la barra inferior en móvil; máximo
  3 apilados, con cierre; el de «Deshacer» lleva su propio botón,
  que comparte el trabajo con el de la barra (deshacer es uno).
  Errores: 9 s; confirmaciones: 6 s; con deshacer: 15 s.
- **Pantalla de entrada** (`.entry`): la cara del login propio —
  marca, una frase llana, contraseña y un escape siempre visible
  («Entrar con mi acceso de siempre»). Se ofrece solo cuando el
  login propio está configurado y sin sesión activa; convive con
  la puerta vigente y no la sustituye en esta versión.
- **Gráficas:** SVG de la casa (barras con `rx:3`, valores encima,
  `<title>` por barra, leyenda con muestras). Dinero: antigüedad en
  barras HTML dentro del resumen y «Saldos abiertos por mes» con
  las series `bar-cobrar`/`bar-pagar`; Hoy: emitidos/recibidos del
  mes (`bar-issued`/`bar-received`).
- **Filas de lista** (`.cp-row` + `.cp-main`): título, detalle y
  meta en líneas separadas; nunca la frase corrida con «·».

## Movimiento y tacto

- Transiciones cortas (120–180 ms) en fondos, filas de tabla
  (`tbody tr:hover` con `--surface-2`) y entrada de diálogos y
  avisos. `prefers-reduced-motion` lo apaga todo (regla global
  previa, se mantiene).
- **Objetivos táctiles:** botón principal 44 px; botones dentro de
  tabla, mínimo 40 px de alto; celdas del mapa de declaraciones,
  48 px; filas de lista, 52 px en móvil. Ningún objetivo nuevo por
  debajo de 40 px.

## Iconografía: un glifo por destino

Cada destino de navegación tiene SU glifo y ningún glifo sirve a
dos destinos: Hoy (rejilla), Dinero (barras), Facturas (fichero),
Documentos (carpeta), Avisos (campana), Buzón (bandeja `i-inbox`),
Buzón Tributario (sobre `i-mail`), Pagos al banco (banco), Cierre
(visto), SAT (escudo), Ajustes (engranaje). En la cabecera, «Abrir
XML» es código (`i-code`) y «Factura PDF» es el PDF (`i-pdf`):
ninguno roba el fichero de Facturas. Símbolo definido = símbolo
usado (lo pina `ronda1110`).

## Impresión

Todo lo que sale en papel es un documento: cabecera con nombre y
RFC, **pie `.report-foot`** (instalación · RFC · fecha larga) en el
reporte mensual, el del periodo y la constancia de listados, y
**paginación en `@page`** («Página X de Y» y «PacoSAT · Expediente
fiscal» en los márgenes inferiores; margen inferior de 17 mm para
que el pie no pise el contenido). Los sellos impresos van a 9.5 px
mínimo.

## Verificación visual (método)

Toda ronda visual se prueba contra el artefacto real servido por
el propio sistema, con la semilla viva de capturas: escritorio
1280×900 y **móvil de 390 px exactos, sin desborde horizontal**
(`documentElement.scrollWidth` = 390 en Hoy, Dinero y Buzón). Las
capturas antes/después viven junto al informe de la ronda
(`~/workspace/pacosat-1XX0-capturas/`).
