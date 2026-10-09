# Panel en vivo (solo lectura)

Guía del panel web del orquestador. Es una vista **estrictamente de solo lectura** sobre los
mismos archivos de estado que usa el servidor MCP: nunca escribe, no toma el lock y no comparte
proceso con el MCP, así que puede quedarse abierto mientras los agentes trabajan.

## Arranque y alcance

```bash
node src/panel.js          # http://127.0.0.1:7480
```

- Puerto y host: `ORQ_PANEL_PORT` (por defecto `7480`) y `ORQ_PANEL_HOST` (por defecto
  `127.0.0.1`). El panel **no tiene autenticación**, así que solo escucha en loopback
  (`127.0.0.1`, `::1`, `localhost`); para salir de ahí hay que autorizarlo a conciencia con
  `ORQ_PANEL_ALLOW_REMOTE=1`.
- Solo atiende `GET` y `HEAD`; cualquier otro método responde `405` con `allow: GET, HEAD`.
- Las páginas se sirven con una **CSP estricta** (`default-src 'self'`) que prohíbe scripts y
  estilos en línea: todo sale de `/static/*` o de la propia API.
- Abre su propio registro de eventos en modo *append-only* sobre `ORQ_STATE_DIR`, así que
  `/auditoria` y `/api/eventos` dejan de responder «no disponible» sin interferir con el MCP.

## Mapa de pantallas

Las tres páginas comparten la cabecera y el `<nav>` de secciones, que marca la actual con
`aria-current="page"`.

| Pantalla | Ruta | Qué muestra |
| --- | --- | --- |
| **Trabajos** | `/` | Lista de trabajos + detalle con pestañas (la única con layout de aplicación a pantalla completa) |
| **Auditoría** | `/auditoria` | Registro global `eventos.jsonl` (más los reconstruidos) en una tabla, renderizada en el servidor sin JS |
| **Pizarrón** | `/pizarron` | Documento compartido (`pizarron.json`) hidratado por el cliente |

En cualquier pantalla, la fila superior «Trabajos / Auditoría / Pizarrón» cambia de sección.
Auditoría y Pizarrón usan un contenedor `.pagina` de ancho cómodo (hasta 1100 px) con scroll
normal de página; solo Trabajos usa el layout de aplicación sin scroll de página.

## Layout de aplicación (Trabajos)

La página principal es una grilla de tres columnas: **lista / divisor / detalle**.

- `body.panel-app` fija `height:100dvh` y `overflow:hidden`: la cabecera queda fija arriba y la
  grilla ocupa el alto restante. **El scroll vive dentro de cada columna**, nunca en la página,
  para que la lista y el detalle no se empujen entre sí.
- La columna de la lista mide `clamp(320px, 28vw, 420px)` y sube a `440px` en pantallas de
  `≥1700px`. El detalle ocupa el resto (`minmax(0,1fr)`).
- El **divisor** es una manija de 6 px (`role="separator"`, `aria-orientation="vertical"`,
  `aria-valuenow/min/max`) y es **ajustable**:
  - con el puntero (arrastre, con `setPointerCapture`);
  - con el teclado cuando tiene el foco: `←`/`→` mueven 16 px, `Home` va al mínimo (280 px),
    `End` al máximo (560 px);
  - doble clic restaura el ancho por defecto para la ventana actual.
  - El ancho elegido se persiste en `localStorage` (`orq.panel.ancho`) y se acota siempre con la
    misma función pura, así un valor viejo o corrupto nunca deja una columna inusable.
- **Maestro-detalle por debajo de 900 px**: se ve la lista **o** el detalle, nunca los dos. Al
  elegir un trabajo se agrega `detalle-abierto` al `<body>` y aparece el botón «← Trabajos»; se
  vuelve con ese botón, con `Esc` (fuera de un campo de texto) o con `Alt+←`.
- **URL y botón Atrás**: la selección se refleja en `?job=<id>` con `history.pushState`, y el
  `popstate` del navegador restaura la selección (o la quita). El filtro de repositorio viaja
  como `?repo=`. Al abrir con `?job=`, ese trabajo se carga apenas llega la lista (aunque no
  esté en ella). En escritorio (`≥900px`) y sin `?job` se autoselecciona el primero; en
  móvil/tablet el panel arranca en la lista.
- Cada columna conserva su scroll por su cuenta. La lista parchea filas de forma incremental
  (no pierde el scroll al llegar una actualización por SSE), y el detalle guarda la pestaña
  activa y la posición de scroll por trabajo.

### Cabecera

Título y marca, y a la derecha: el indicador de **conexión** («En vivo» / «Reconectando…»), una
píldora de **concurrencia** (`n/máx en curso`, con barra de uso cuando hay tope), una píldora de
**cola** solo si hay trabajos esperando, y el botón **«Atajos (?)»**. El `document.title` antepone
`n corriendo · ` cuando hay trabajos activos y cierra con ` · opencode-orchestrator`.

## Toolbar y filtros (lista)

La toolbar queda fija arriba de la lista y se apila en tres filas que nunca desbordan:

1. **Búsqueda** por título, id, rama o modelo (con botón «limpiar»).
2. **Control segmentado de estado**: `Todos`, `Activos`, `Problemas` (estado `fallidos`) y
   `Terminados`, cada uno con su contador. En columnas angostas la etiqueta larga se cambia por
   una corta (`Fallos`, `Hechos`) mediante consultas de contenedor.
3. **Repositorio** (un `<select>`: «Todos los repositorios» + `nombre (n)`), **Orden**
   (`Actividad reciente`, `Estado`, `Creación`) y **Densidad** («Cómoda» / «Compacta»).

La lista ordena con el criterio elegido y agrupa en **«En curso»** y **«Terminados»**, con
encabezados y contador. Cada fila muestra estado (texto + ícono + color), título, id corto,
duración, hora relativa, semáforo de atasco y avisos.

**Persistencia** (con `try/catch`, así sin `localStorage` la UI sigue en memoria):
`orq.panel.repo`, `orq.panel.orden`, `orq.panel.densidad`, `orq.panel.ancho`,
`orq.panel.envolver` y `orq.panel.tamano`.

## Detalle: pestañas

La barra de título + pestañas queda fija; solo el contenido de la pestaña scrollea. La etiqueta
de la pestaña puede traer un contador barato (`Diff 3`, `Eventos 5`) calculado con lo ya cargado,
sin disparar pedidos extra; la omisión del cero es una función pura. Alcance suma un ícono de
advertencia solo si hay archivos fuera.

### Resumen

- Franja de **tarjetas**: Estado, Duración, Repositorio, Modelo y Rama (con «Copiar rama»).
- Acción «Abrir consola»; «Copiar id» vive una sola vez, junto al título.
- **Cajas** por aviso/resultado, solo si hay contenido: «Motivo de fin», «Advertencias»,
  «Mutaciones» (`detectada/total`), «Revisión» (veredicto) y «Aceptación: qué falló».
- La **tarea** y la **última salida** van en `<details>` plegables (la última salida solo si hay
  texto, recortada a 2000 caracteres). Mientras carga se muestra un esqueleto con `aria-busy` y,
  ante error, un mensaje con botón «Reintentar».

### Consola

- **Fuente**: `Agente`, `Aceptación` o `stderr de aceptación`.
- **Búsqueda** dentro de la salida con contador `n de m`, resaltado y navegación con
  `Enter`/`Shift+Enter` (sin salir del campo). `Ctrl`/`Cmd`+`F` y `/` enfocan esta búsqueda
  cuando el foco está en la consola.
- **Ajustar líneas** (wrap); desactivado usa scroll horizontal. **Tamaño de fuente** `A−`/`A+`
  entre 12 y 18 px.
- **Copiar** y **Descargar .log**.
- **Auto-seguimiento inteligente**: si el usuario se aleja del final, se pausa solo (aparece «En
  pausa»); al volver al final se reanuda. Con el seguimiento pausado, el botón flotante
  «Ir al final (n)» acumula cuántas líneas nuevas llegaron. La salida se refresca por sondeo
  cada 1,5 s y conserva las últimas 2000 líneas.

### Diff

- **Cabecera** con totales (`n archivos · +a −d`), salto rápido «Ir a archivo…», «Expandir todo»,
  «Plegar todo» y «Copiar parche».
- Un `<details>` por archivo con estado (alta/baja/modificado/renombrado), ruta, `+/−` y una
  barra proporcional al tamaño del cambio. El primer archivo **con cambios** arranca abierto.
- Los archivos de más de 400 líneas no se renderizan hasta tocar «Mostrar (n líneas)».
- Si el parche viene truncado se avisa («El parche está truncado…»).

### Alcance

Resumen de `writes` declarados, patrones `protegidas`, archivos `tocados` y cuáles quedaron
**fuera de alcance** (marcados en rojo). Suma, si existen, las «Mutaciones» y la «Revisión».

### Eventos

Lista ordenada de los eventos del trabajo: hora, tipo crudo, transición de estado
(`anterior → estado`) y motivo legible.

## Historial reconstruido (Auditoría)

`/auditoria` se **renderiza en el servidor** (sin JS): es una tabla de solo lectura cuyos filtros
viajan por query string y se reenvían a la consulta.

- Filtros: `jobId`, `tipo`, `desde` y `hasta` (timestamps), con botones «Filtrar» y «Limpiar».
- Paginación por «Cargar más», que suma un paso de 200 al `limite`. Hay un tope de 10 000; en el
  tope el enlace se oculta y se avisa «Mostrando los N más recientes; filtrá por fechas para ver
  más» para que lo viejo no quede inalcanzable en silencio.
- Los trabajos anteriores al registro **se reconstruyen** desde su `job.json` (creación, arranque
  y fin), se mezclan por fecha con los eventos reales y se marcan con la insignia «histórico»
  (`origen: 'reconstruido'`). Los reales llevan `origen: 'registro'`.
- Cada fila muestra hora legible (`dd/mm hh:mm:ss`) con el ISO en `datetime`/`title`, un chip de
  tipo coloreado por categoría (servidor, job, merge, pizarrón, cleanup), el trabajo enlazado a
  `/?job=<id>`, la transición y el motivo legible.

## Pizarrón

`/pizarron` hidrata el documento con `/static/pizarron.js`, que refresca por polling cada 5 s
contra `/api/pizarron` (sin escrituras).

- **Claves**: valor vigente, autor (enlace a `/?job=`), hora y marca de «conflicto» si el
  historial tiene una entrada en conflicto. Los valores de más de 60 caracteres se pliegan tras
  «ver más».
- **Notas recientes**: las últimas 20, con hora, autor y texto.
- El repintado se omite si el documento no cambió y, cuando cambia, restaura los plegables
  abiertos y la posición del scroll. Sin datos muestra un estado vacío informativo.

## Atajos de teclado

Lista completa, tal como está en el cliente y en el diálogo «Atajos (?)»:

| Tecla | Acción |
| --- | --- |
| `j` / `k` | Trabajo siguiente / anterior (funcionan aun con el foco en la búsqueda, sin robarlo) |
| `/` | Buscar trabajos; con la consola enfocada, busca dentro de la consola |
| `1`–`5` | Pestañas Resumen, Consola, Diff, Alcance, Eventos |
| `f` | Seguir / pausar la consola |
| `Esc` | Volver a la lista (fuera de un campo de texto; el diálogo de ayuda abierto tiene prioridad) |
| `Alt`+`←` | Volver a la lista |
| `←` / `→` | Ancho de la lista (con el foco en el divisor; 16 px por paso) |
| `Home` / `End` | Ancho mínimo / máximo de la lista |
| Doble clic en el divisor | Ancho de la lista por defecto |
| `Ctrl`/`Cmd`+`F` | Buscar dentro de la consola (con el foco en ella) |
| `Enter` / `Shift`+`Enter` | Siguiente / anterior coincidencia en la consola |
| `←`/`→`/`Home`/`End` en las pestañas | Mover el foco entre pestañas |
| `?` | Abrir la ayuda de atajos |

## Accesibilidad

- `<html lang="es">`, landmarks (`header`, `nav`, `main`), enlace «Saltar al contenido» y
  `tabindex="-1"` en el `<main>` para el foco.
- Pestañas con `role="tablist"`/`tab`/`tabpanel` y `aria-selected`; navegación de pestañas con
  flechas/`Home`/`End`. La selección de la lista se marca con `aria-current`; los toggles con
  `aria-pressed`; las regiones en carga con `aria-busy`.
- Anuncios de cambios de estado en una región `aria-live="polite"` (`#anuncios`).
- Foco visible con contorno de 2 px (`:focus-visible`).
- **Contraste AA verificado por test**: los tokens de color se comprueban con la función pura
  `contraste()` (≥ 4.5 en texto, ≥ 3 en bordes/UI) en tema claro y oscuro, en
  `test/panel-ui.test.js`.
- Estados siempre con **texto + ícono + color** (nunca solo color).
- `prefers-reduced-motion:reduce` apaga transiciones y animaciones; `forced-colors:active` usa
  `CanvasText`/`Highlight`/`ButtonText` para no depender de los tokens.
- En móvil los objetivos táctiles crecen (≥ 36–40 px) y la cabecera se compacta.

## Sistema de diseño

- **Tokens semánticos** en `:root` (tema claro) y su par en `prefers-color-scheme: dark`.
  Ninguna regla de componente escribe un color literal: todo sale de un token, y por eso el
  contraste se puede auditar y no puede degradarse sin que falle la suite.
- **Íconos SVG propios** (`src/panel/iconos.js`): trazos de 1,75 px en un lienzo de 24×24 con
  `currentColor`, sin glifos Unicode (que se veían distintos según el sistema). Hay un SVG por
  estado y por acción de interfaz; el color refuerza, pero el texto siempre está al lado.
- **Tipografía por rol** con pilas del sistema: `--fuente-ui` (cuerpo, controles, listas),
  `--fuente-titulo` (títulos), `--fuente-codigo` (solo datos técnicos: ids, ramas, rutas, logs,
  diff, JSON) y `--fuente-numeros` (cifras tabulares). **No hay webfonts**: la CSP solo permite
  `font-src`/`style-src 'self'` y el proyecto tiene **cero dependencias externas**, así que se
  usan las pilas nativas del sistema operativo.

## Rutas estáticas y de API que consume

Estáticas (con `no-cache`, `ETag` y `304` al revalidar):

- `/static/app.css`, `/static/app.js`, `/static/lib.js` (lógica pura), `/static/iconos.js`,
  `/static/pizarron.js`, `/static/favicon.svg`.

Páginas:

- `/`, `/auditoria` (query `jobId`, `tipo`, `desde`, `hasta`, `limite`), `/pizarron`.

API (JSON, `no-store`):

- `GET /api/trabajos` — listado liviano; query `limite` (300 por defecto, máx 1000), `desde` y
  `repo`.
- `GET /api/trabajos/:id` — detalle (prompt, transcript, respuesta, fallos) truncado.
- `GET /api/trabajos/:id/log` — por rangos; query `fuente=agente|aceptacion|stderr`, `desde`,
  `limite` y `ansi=1`.
- `GET /api/trabajos/:id/diff`, `/alcance`, `/eventos`.
- `GET /api/eventos` — registro filtrable (`jobId`, `tipo`, `desde`, `hasta`, `limite`), con
  `hayMas` y `enTope` como campos **aditivos**.
- `GET /api/estado` — resumen global (cola, corriendo, último evento).
- `GET /api/pizarron` — documento del pizarrón.
- `GET /api/stream` — SSE con eventos `trabajos` y `estado` (más `: keepalive`).

El cliente usa SSE y, si no está disponible o se cae, cae a **polling** cada 3 s
(`/api/trabajos` + `/api/estado`).

## Límites

- **Listado liviano**: sin prompt/transcript; tope por defecto 300 trabajos, máximo 1000.
- **Detalle truncado a 64 KB** (`MAX_BYTES_DETALLE = 65 536`): el prompt y el transcript se
  recortan y el detalle avisa con `truncado`.
- **Logs por rangos** de hasta 64 KB por pedido (`LIMITE_MAX = 65 536`).
- **Diff**: parche recortado a 400 KB (con aviso de truncado), buffer interno de 8 MB.
- **Auditoría**: página de 200 eventos (paso de «Cargar más»), tope duro de 10 000.
- **Consola**: conserva las últimas 2000 líneas.
- **Diff por archivo**: más de 400 líneas queda plegado hasta pedirlo.
- **Pizarrón**: valores de más de 60 caracteres plegables; últimas 20 notas.
- **SSE**: máximo 8 clientes simultáneos (`MAX_CLIENTES = 8`); al superarlo responde `503`.

## Cómo probarlo sin tocar el estado real

```bash
node scripts/panel-demo.js --puerto 7490   # http://127.0.0.1:7490
```

El script arma un estado **temporal** propio con datos representativos: 12 trabajos de todos los
estados, eventos de todos los tipos, trabajos sin registro (que la UI reconstruye), un pizarrón
con una clave en conflicto y logs largos con ANSI. Por seguridad, si el entorno trae un
`ORQ_STATE_DIR` que ya existe en disco (el estado real) se niega a arrancar; al salir con `Ctrl-C`
borra el temporal. El puerto por defecto de la demo es `7490`, distinto del `7480` real.

## Verificación visual

Con el panel de demo abierto, revisá estos tres anchos:

- **1366 px** — layout de tres columnas con el divisor; la lista entra cómoda y el detalle no
  empuja scroll de página.
- **1920 px** — la lista sube a 440 px y el detalle aprovecha el ancho; encabezados y toolbar
  siguen pegados.
- **390 px** — maestro-detalle: arranca en la lista, al tocar un trabajo se ve el detalle a
  pantalla completa con «← Trabajos»; la cabecera compacta (píldoras y «En vivo» como punto).

En los tres casos comprobá el tema claro y oscuro (`prefers-color-scheme`), el foco por teclado
(`Tab`) y que `/`, `j`/`k`, `1`–`5`, `f` y `?` respondan.
