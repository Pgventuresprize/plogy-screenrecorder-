// Corre dentro de la pestaña de Meet. Mientras se graba, activa los subtítulos de Meet,
// lee quién dice qué y se lo pasa al background cada pocos segundos.
//
// Meet cambia sus clases CSS seguido, así que no se usan: se busca la región de subtítulos
// por su rol/aria-label y cada bloque por el avatar de quien habla ("Nombre\nTexto…").

(() => {
  if (globalThis.__plogyTranscriptor) return; // ya inyectado
  globalThis.__plogyTranscriptor = true;

  const ENVIO_MS = 5000;
  const BUSQUEDA_MS = 1000;

  let activo = false;
  let sesionId = null;
  let desde = 0;
  let entradas = []; // { nombre, texto, t } — t en ms desde que empezó la grabación
  let porBloque = new WeakMap(); // bloque del DOM → entrada que está escribiendo
  let cambios = false;
  let regionObservada = null;
  let observador = null;
  let temporizadores = [];
  let pendiente = null;
  let ultimoEstado = null;
  let intentosActivar = 0;

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

  function activarSubtitulos() {
    const botones = [...document.querySelectorAll('button')];
    const etiqueta = (b) => b.getAttribute('aria-label') || '';
    const boton =
      botones.find((b) => /(activar|turn on|ativar|show|mostrar).*(subt[ií]tul|caption|legenda)/i.test(etiqueta(b))) ||
      botones.find((b) => /subt[ií]tul|caption|legenda/i.test(etiqueta(b)) && b.getAttribute('aria-pressed') === 'false');
    if (boton) boton.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true }));
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
    if (!activo || !regionObservada) return;
    for (const bloque of bloques(regionObservada)) {
      const [nombre, ...resto] = bloque.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const texto = resto.join(' ');
      if (!nombre || !texto) continue;

      const entrada = porBloque.get(bloque);
      if (entrada && entrada.nombre === nombre && !esFraseNueva(entrada.texto, texto)) {
        if (entrada.texto !== texto) {
          entrada.texto = texto;
          cambios = true;
        }
        continue;
      }
      const nueva = { nombre, texto, t: Math.max(0, Date.now() - desde) };
      entradas.push(nueva);
      porBloque.set(bloque, nueva);
      cambios = true;
    }
  }

  function programarLectura() {
    pendiente ??= setTimeout(leer, 250);
  }

  function informar(ok) {
    if (ok === ultimoEstado) return;
    ultimoEstado = ok;
    avisar({ tipo: 'transcriptor-estado', sesionId, ok });
  }

  // la región aparece/desaparece al prender/apagar subtítulos: se vigila y se re-engancha
  function vigilarRegion() {
    const region = buscarRegion();
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

  // ── ciclo ──

  function iniciar(msg) {
    detener();
    activo = true;
    sesionId = msg.sesionId;
    desde = msg.desde;
    entradas = [];
    porBloque = new WeakMap();
    cambios = false;
    ultimoEstado = null;
    intentosActivar = 0;
    vigilarRegion();
    temporizadores = [setInterval(vigilarRegion, BUSQUEDA_MS), setInterval(enviar, ENVIO_MS)];
  }

  function detener() {
    if (activo) leer();
    activo = false;
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    clearTimeout(pendiente);
    pendiente = null;
    observador?.disconnect();
    observador = null;
    regionObservada = null;
    return entradas;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
    if (msg.destino !== 'transcriptor') return;
    if (msg.tipo === 'ping') responder({ ok: true });
    if (msg.tipo === 'iniciar') {
      iniciar(msg);
      responder({ ok: true });
    }
    if (msg.tipo === 'detener') responder({ ok: true, sesionId, lineas: detener() });
  });
})();
