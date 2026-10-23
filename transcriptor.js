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
  // así innerText trae los saltos de línea, y Meet, que reserva abajo el alto que mide, le
  // devuelve ese espacio al video. Moverla fuera de pantalla no sirve: conserva su alto.
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
      aplastadas: aplastadas.map(describir),
      videos: [...document.querySelectorAll('video')].map((v) => describir(v.parentElement)),
      escalado: escalado ? { ...describir(escalado), transform: getComputedStyle(escalado).transform } : null,
      decision,
      hojaConectada: !!hoja?.isConnected,
      reglaEscala,
      regiones: [...document.querySelectorAll('[role="region"]')].map(describir),
      botones: [...document.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label'))
        .filter((a) => /subt|caption|legenda/i.test(a)),
      ancestros,
    };
  }

  // Se aplasta toda la cadena, desde la caja exterior hasta el padre de la región: Meet le
  // reserva al video el alto de una caja interior (a4cQT, 216 px en el diagnóstico real), no
  // el de la exterior. La región misma no se toca: ahí se leen los subtítulos.
  // Se llama cada segundo: si Meet vuelve a crear alguna caja, se aplasta también.
  //
  // Los estilos van en una hoja propia, no en el atributo style: Meet reescribe el style de sus
  // elementos y borraba lo que se le ponía. Los elementos se marcan con un atributo data-*.
  let aplastadas = [];
  let hoja = null;
  let reglaEscala = '';

  const MARCA_APLASTAR = 'data-plogy-aplastar';
  const MARCA_ESCALA = 'data-plogy-escala';
  const REGLA_APLASTAR = `[${MARCA_APLASTAR}] { ${ESTILO_OCULTO.map(([p, v]) => `${p}: ${v} !important;`).join(' ')} }`;

  function pintarHoja() {
    if (!hoja?.isConnected) {
      hoja = document.createElement('style');
      hoja.id = 'plogy-estilos';
      (document.head || document.documentElement).append(hoja);
    }
    const texto = `${REGLA_APLASTAR}\n${reglaEscala}`;
    if (hoja.textContent !== texto) hoja.textContent = texto;
  }

  function ocultarRegion(region) {
    const caja = cajaDeSubtitulos(region);
    const cadena = [];
    for (let el = region.parentElement; el; el = el.parentElement) {
      cadena.push(el);
      if (el === caja) break;
    }
    for (const el of aplastadas) if (!cadena.includes(el)) restaurar(el);
    for (const el of cadena) el.setAttribute(MARCA_APLASTAR, '');
    aplastadas = cadena;
    cajaOculta = caja;
    pintarHoja();
  }

  function restaurar(el) {
    el.removeAttribute(MARCA_APLASTAR);
  }

  function mostrarRegion() {
    aplastadas.forEach(restaurar);
    aplastadas = [];
    cajaOculta = null;
    soltarVideo();
    hoja?.remove();
    hoja = null;
  }

  // ── video a pantalla completa con subtítulos activos ──
  //
  // Con CC activado Meet reserva abajo la franja de subtítulos aunque la caja mida 0: decide por
  // el estado, no por lo que mide (diagnóstico real: video de 480 px, 224 px vacíos debajo).
  // No se pelea con su layout: se escala el contenedor de los videos con transform, que Meet
  // no mide (ResizeObserver y clientWidth ignoran transform), hasta llenar el espacio libre.

  let escalado = null; // contenedor al que se le aplicó la escala
  let decision = 'sin calcular'; // última decisión, para el diagnóstico

  function soltarVideo(motivo) {
    escalado?.removeAttribute(MARCA_ESCALA);
    escalado = null;
    if (motivo) decision = motivo;
    if (reglaEscala) {
      reglaEscala = '';
      if (hoja) pintarHoja();
    }
  }

  // solo videos que se ven de verdad: dentro de la pantalla, visibles y con tamaño
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function ancestroComun(nodos) {
    let comun = nodos[0].parentElement;
    while (comun && !nodos.every((n) => comun.contains(n))) comun = comun.parentElement;
    return comun;
  }

  function limiteInferior() {
    const controles = [...document.querySelectorAll('[role="region"]')].find((r) =>
      /controles|controls|controlos/i.test(r.getAttribute('aria-label') || '')
    );
    const top = controles?.getBoundingClientRect().top;
    return (top > innerHeight / 2 ? top : innerHeight - 80) - 16;
  }

  function ajustarVideo() {
    // los recuadros grandes (se ignoran miniaturas como la vista propia flotante)
    // se mide sin la escala propia (en la misma tarea, así no hay parpadeo)
    escalado?.removeAttribute(MARCA_ESCALA);

    const recuadros = [...document.querySelectorAll('video')]
      .filter((v) => !v.closest('plogy-notch'))
      .map((v) => v.parentElement)
      .filter((p) => p && visible(p));
    if (!recuadros.length) return soltarVideo('no hay videos visibles');

    const area = (r) => r.width * r.height;
    const maxArea = Math.max(...recuadros.map((p) => area(p.getBoundingClientRect())));
    const grandes = recuadros.filter((p) => area(p.getBoundingClientRect()) >= maxArea * 0.4);
    const objetivo = ancestroComun(grandes);
    if (!objetivo || objetivo === document.body) return soltarVideo('sin contenedor común');
    if (escalado && escalado !== objetivo) soltarVideo();
    if (getComputedStyle(objetivo).transform !== 'none') {
      return soltarVideo('el contenedor ya tiene un transform de Meet'); // no pisarlo
    }

    const rs = grandes.map((p) => p.getBoundingClientRect());
    const u = {
      x: Math.min(...rs.map((r) => r.left)),
      y: Math.min(...rs.map((r) => r.top)),
      der: Math.max(...rs.map((r) => r.right)),
      abajo: Math.max(...rs.map((r) => r.bottom)),
    };
    u.w = u.der - u.x;
    u.h = u.abajo - u.y;
    const cx = u.x + u.w / 2;
    const medioAncho = Math.min(cx - 16, innerWidth - 16 - cx); // simétrico: respeta paneles laterales
    const abajo = limiteInferior();
    const s = Math.min((abajo - u.y) / u.h, (2 * medioAncho) / u.w);
    const medida = `${grandes.length} video(s) ${Math.round(u.w)}x${Math.round(u.h)} en y=${Math.round(u.y)}, límite ${Math.round(abajo)}`;
    if (!(s > 1.02)) return soltarVideo(`no hace falta agrandar (${medida}, escala ${s.toFixed(2)})`);

    // con transform-origin 0 0: p' = o + s·(p − o) + t, con o = esquina del contenedor
    const o = objetivo.getBoundingClientRect();
    const nuevoX = cx - (s * u.w) / 2;
    const nuevoY = u.y + (abajo - u.y - s * u.h) / 2;
    const tx = nuevoX - o.left - s * (u.x - o.left);
    const ty = nuevoY - o.top - s * (u.y - o.top);
    reglaEscala = `[${MARCA_ESCALA}] { transform-origin: 0 0 !important; transform: translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)}) !important; }`;
    pintarHoja();
    objetivo.setAttribute(MARCA_ESCALA, '');
    escalado = objetivo;
    decision = `agrandado x${s.toFixed(2)} (${medida})`;
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
    if (region) {
      ocultarRegion(region);
      ajustarVideo();
    } else soltarVideo('sin subtítulos activos');
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
    addEventListener('resize', alRedimensionar);
  }

  // Meet reacomoda los videos al cambiar el tamaño: se reajusta justo después, sin esperar al ciclo
  let reajuste = null;
  function alRedimensionar() {
    clearTimeout(reajuste);
    reajuste = setTimeout(() => activo && regionObservada && ajustarVideo(), 150);
  }

  // devuelve lo transcrito; deja los subtítulos de Meet como estaban
  function detener() {
    if (activo) {
      leer();
      enviar();
    }
    activo = false;
    removeEventListener('resize', alRedimensionar);
    clearTimeout(reajuste);
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
