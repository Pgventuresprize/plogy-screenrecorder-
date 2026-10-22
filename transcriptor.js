// Corre dentro de la pestaña de Meet (lo maneja notch.js). Activa los subtítulos de Meet,
// los saca de la vista (la franja de abajo es enorme) y va leyendo quién dice qué.
//
// Meet cambia sus clases CSS seguido, así que no se usan: se busca la región de subtítulos
// por su rol/aria-label y cada bloque por el avatar de quien habla ("Nombre\nTexto…").

(() => {
  if (globalThis.PlogyTranscriptor) return; // ya inyectado

  const ENVIO_MS = 5000;
  const BUSQUEDA_MS = 1000;

  let activo = false;
  let pausado = false;
  let sesionId = null;
  let reloj = () => 0; // ms de video grabado (descuenta las pausas)
  let alCambiar = () => {};
  let alEstado = () => {};
  let entradas = []; // { nombre, texto, t }
  let porBloque = new WeakMap(); // bloque del DOM → entrada que está escribiendo
  let cambios = false;
  let regionObservada = null;
  let cajaOculta = null;
  let observador = null;
  let temporizadores = [];
  let pendiente = null;
  let ultimoEstado = null;
  let intentosActivar = 0;
  let activadosPorNosotros = false;

  const avisar = (msg) => chrome.runtime.sendMessage({ destino: 'background', ...msg }).catch(() => {});

  // ── DOM de Meet ──

  const RE_REGION = /subt[ií]tul|caption|legenda|sous-titre|untertitel/i;

  function buscarRegion() {
    const regiones = [...document.querySelectorAll('[role="region"]')];
    return (
      regiones.find((r) => RE_REGION.test(r.getAttribute('aria-label') || '')) ||
      // respaldo: la región enfocable que tiene avatares y texto
      regiones.find((r) => r.getAttribute('tabindex') === '0' && r.querySelector('img') && r.innerText.trim())
    );
  }

  // un bloque = el contenedor más cercano al avatar cuyo texto ya trae "Nombre\nTexto"
  function bloques(region) {
    const encontrados = new Set();
    for (const img of region.querySelectorAll('img')) {
      let el = img.parentElement;
      while (el && el !== region && !(el.innerText || '').includes('\n')) el = el.parentElement;
      if (el && el !== region) encontrados.add(el);
    }
    return [...encontrados];
  }

  function botonSubtitulos(prender) {
    const accion = prender ? '(activar|turn on|ativar|show|mostrar)' : '(desactivar|turn off|desativar|hide|ocultar)';
    const re = new RegExp(`${accion}.*(subt[ií]tul|caption|legenda)`, 'i');
    return [...document.querySelectorAll('button')].find((b) => re.test(b.getAttribute('aria-label') || ''));
  }

  function activarSubtitulos() {
    const boton = botonSubtitulos(true);
    if (boton) boton.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true }));
    activadosPorNosotros = true;
  }

  // Se aplasta a 0 px en su sitio en vez de ocultarla: el contenido sigue renderizado (recortado),
  // así innerText trae los saltos de línea, y Meet, que reserva abajo el alto que mide en la caja,
  // le devuelve ese espacio al video. Se aplasta la caja completa (texto + selector de idioma +
  // ajustes), no solo el texto. Moverla fuera de pantalla no sirve: conserva su alto y Meet
  // sigue reservando la franja.
  const ESTILO_OCULTO = [
    ['height', '0px'],
    ['min-height', '0px'],
    ['max-height', '0px'],
    ['padding', '0px'],
    ['margin', '0px'],
    ['border', '0px'],
    ['overflow', 'hidden'],
    ['opacity', '0'],
    ['pointer-events', 'none'],
  ];

  // sube desde la región hasta antes de tocar los videos o la barra de controles de Meet
  function cajaDeSubtitulos(region) {
    const botonCC = botonSubtitulos(false) || botonSubtitulos(true);
    let caja = region;
    for (let el = region.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector('video') || (botonCC && el.contains(botonCC))) break;
      if (el.getBoundingClientRect().height > innerHeight * 0.6) break;
      caja = el;
    }
    return caja;
  }

  // ── diagnóstico: estructura alrededor de los subtítulos, sin el texto de lo que se dice ──

  function describir(el) {
    if (!el || el.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      clase: (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 4).join(' ') || undefined,
      jsname: el.getAttribute('jsname') || undefined,
      rol: el.getAttribute('role') || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      estilo: el.getAttribute('style')?.slice(0, 200) || undefined,
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      pos: cs.position,
      display: cs.display,
      hijos: el.children.length,
      video: !!el.querySelector('video') || undefined,
      textoLargo: (el.innerText || '').length,
    };
  }

  function diagnostico() {
    const region = buscarRegion();
    const ancestros = [];
    for (let el = region; el && el !== document.documentElement; el = el.parentElement) {
      ancestros.push({ ...describir(el), hermanos: [...(el.parentElement?.children || [])].map(describir) });
    }
    return {
      viewport: [innerWidth, innerHeight],
      regionEncontrada: !!region,
      cajaOculta: describir(cajaOculta),
      regiones: [...document.querySelectorAll('[role="region"]')].map(describir),
      botones: [...document.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label'))
        .filter((a) => /subt|caption|legenda/i.test(a)),
      ancestros,
    };
  }

  function ocultarRegion(region) {
    if (cajaOculta?.contains(region)) return;
    const caja = cajaDeSubtitulos(region);
    mostrarRegion();
    for (const [p, v] of ESTILO_OCULTO) caja.style.setProperty(p, v, 'important');
    cajaOculta = caja;
  }

  function mostrarRegion() {
    if (cajaOculta) for (const [p] of ESTILO_OCULTO) cajaOculta.style.removeProperty(p);
    cajaOculta = null;
  }

  // ── lectura ──

  // Meet a veces reutiliza un bloque para una frase nueva: si el texto se acortó mucho
  // y ya no empieza igual, es otra entrada
  function esFraseNueva(viejo, nuevo) {
    const inicio = (s) => s.slice(0, 15).toLowerCase();
    return nuevo.length < viejo.length * 0.6 && inicio(viejo) !== inicio(nuevo);
  }

  function leer() {
    pendiente = null;
    if (!activo || pausado || !regionObservada) return;
    let hubo = false;
    for (const bloque of bloques(regionObservada)) {
      const [nombre, ...resto] = bloque.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const texto = resto.join(' ');
      if (!nombre || !texto) continue;

      const entrada = porBloque.get(bloque);
      if (entrada && entrada.nombre === nombre && !esFraseNueva(entrada.texto, texto)) {
        if (entrada.texto !== texto) {
          entrada.texto = texto;
          hubo = true;
        }
        continue;
      }
      const nueva = { nombre, texto, t: Math.max(0, reloj()) };
      entradas.push(nueva);
      porBloque.set(bloque, nueva);
      hubo = true;
    }
    if (hubo) {
      cambios = true;
      alCambiar(entradas);
    }
  }

  function programarLectura() {
    pendiente ??= setTimeout(leer, 250);
  }

  function informar(ok) {
    if (ok === ultimoEstado) return;
    ultimoEstado = ok;
    alEstado(ok);
    avisar({ tipo: 'transcriptor-estado', sesionId, ok });
  }

  // la región aparece/desaparece al prender/apagar subtítulos: se vigila y se re-engancha
  function vigilarRegion() {
    const region = buscarRegion();
    if (region) ocultarRegion(region);
    if (region !== regionObservada) {
      observador?.disconnect();
      regionObservada = region || null;
      if (region) {
        observador = new MutationObserver(programarLectura);
        observador.observe(region, { childList: true, subtree: true, characterData: true });
        programarLectura();
      }
    }
    if (!region && intentosActivar < 3) {
      intentosActivar++;
      activarSubtitulos();
      // los subtítulos tardan un instante en aparecer: volver a mirar sin esperar al ciclo normal
      setTimeout(() => activo && vigilarRegion(), 300);
    }
    informar(!!region);
  }

  function enviar() {
    if (!cambios) return;
    cambios = false;
    avisar({ tipo: 'transcripcion', sesionId, lineas: entradas });
  }

  // ── API para notch.js ──

  function iniciar(opciones) {
    detener();
    activo = true;
    pausado = false;
    ({ sesionId, reloj, alCambiar = () => {}, alEstado = () => {} } = opciones);
    entradas = [];
    porBloque = new WeakMap();
    cambios = false;
    ultimoEstado = null;
    intentosActivar = 0;
    activadosPorNosotros = false;
    vigilarRegion();
    temporizadores = [setInterval(vigilarRegion, BUSQUEDA_MS), setInterval(enviar, ENVIO_MS)];
  }

  // devuelve lo transcrito; deja los subtítulos de Meet como estaban
  function detener() {
    if (activo) {
      leer();
      enviar();
    }
    activo = false;
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    clearTimeout(pendiente);
    pendiente = null;
    observador?.disconnect();
    observador = null;
    regionObservada = null;
    mostrarRegion();
    if (activadosPorNosotros) {
      botonSubtitulos(false)?.click();
      activadosPorNosotros = false;
    }
    return entradas;
  }

  globalThis.PlogyTranscriptor = {
    iniciar,
    detener,
    diagnostico,
    pausar: () => {
      leer();
      pausado = true;
    },
    reanudar: () => {
      pausado = false;
    },
    get activo() {
      return activo;
    },
    get lineas() {
      return entradas;
    },
  };
})();
