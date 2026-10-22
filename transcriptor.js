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

  // Se mueve fuera de pantalla en vez de ocultarla: sigue renderizada, así innerText trae los saltos
  // de línea. Se sube por los contenedores de un solo hijo para no dejar la caja negra vacía.
  const ESTILO_OCULTO = [
    ['position', 'fixed'],
    ['left', '-10000px'],
    ['top', '0'],
    ['width', '900px'],
    ['pointer-events', 'none'],
  ];

  function ocultarRegion(region) {
    let caja = region;
    while (caja.parentElement && caja.parentElement !== document.body && caja.parentElement.children.length === 1) {
      caja = caja.parentElement;
    }
    if (caja === cajaOculta) return;
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
