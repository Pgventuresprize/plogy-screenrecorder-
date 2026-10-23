// Notch de controles sobre Meet mientras se graba: barra compacta arrastrable con tiempo,
// pausar y guardar, y un panel desplegable con la transcripción en vivo y notas propias.
//
// No sale en el video: antes de mostrarse o moverse le pasa al grabador su área exacta y
// el grabador la tapa cuadro por cuadro (ver conMascaras en offscreen.js).
//
// Meet exige Trusted Types: nada de innerHTML, todo se arma con createElement/textContent.

(() => {
  if (globalThis.__plogyNotch) return; // ya inyectado
  globalThis.__plogyNotch = true;
  console.info('[Plogy] extensión cargada en esta pestaña');

  // geometría fija: la máscara del video se calcula con estos mismos números
  const BARRA_ANCHO = 452;
  const BARRA_ALTO = 46;
  const PANEL_ANCHO = 600;
  const PANEL_ALTO = 330;
  const MARGEN = 8;
  const HOLGURA = 10; // px extra de máscara alrededor
  const HOLGURA_ARRASTRE = 28;

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const enviar = (msg) => chrome.runtime.sendMessage({ destino: 'background', ...msg }).catch(() => null);

  let host = null;
  let raiz = null;
  let el = {}; // referencias a nodos
  let s = null; // { sesionId, desde, pausado, pausadoDesde, pausadoTotal, transcribir }
  let pos = null; // { cx, y }: centro horizontal y borde superior de la barra
  let abierto = false;
  let pestana = 'transcripcion';
  let confirmando = false;
  let subtitulosOk = null;
  let notas = '';
  let tic = null;

  // ── tiempo de video (descuenta las pausas) ──

  function tiempo() {
    if (!s) return 0;
    const hasta = s.pausado ? s.pausadoDesde : Date.now();
    return hasta - s.desde - (s.pausadoTotal || 0);
  }

  function hms(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(t / 3600);
    return `${h ? `${p(h)}:` : ''}${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
  }

  // ── DOM sin innerHTML ──

  function h(tag, props = {}, ...hijos) {
    const nodo = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') nodo.className = v;
      else if (k === 'dataset') Object.assign(nodo.dataset, v);
      else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== false) nodo.setAttribute(k, v === true ? '' : v);
    }
    for (const c of hijos.flat()) if (c != null) nodo.append(c);
    return nodo;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function icono(...formas) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })) svg.setAttribute(k, v);
    for (const [tag, attrs] of formas) {
      const f = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
      svg.append(f);
    }
    return svg;
  }

  const ICONOS = {
    pausa: () => icono(['rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }], ['rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }]),
    seguir: () => icono(['path', { d: 'M7 5l12 7-12 7z', fill: 'currentColor' }]),
    parar: () => icono(['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]),
    chevron: () => icono(['path', { d: 'M6 9l6 6 6-6' }]),
    asa: () =>
      icono(
        ...[[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]].map(([cx, cy]) => [
          'circle', { cx, cy, r: 1.3, fill: 'currentColor', stroke: 'none' },
        ])
      ),
  };

  // ── máscaras: lo que el grabador tapa en el video ──

  const anchoPanel = () => Math.min(PANEL_ANCHO, innerWidth - 2 * MARGEN);
  const altoPanel = () => Math.min(PANEL_ALTO, innerHeight - BARRA_ALTO - 3 * MARGEN);

  function areas(p, conPanel, holgura = HOLGURA) {
    const r = [{ x: p.cx - BARRA_ANCHO / 2, y: p.y, w: BARRA_ANCHO, h: BARRA_ALTO }];
    if (conPanel) r.push({ x: p.cx - anchoPanel() / 2, y: p.y + BARRA_ALTO - 1, w: anchoPanel(), h: altoPanel() });
    return r.map(({ x, y, w, h: alto }) => ({ x: x - holgura, y: y - holgura, w: w + 2 * holgura, h: alto + 2 * holgura }));
  }

  // con tope de espera: si el grabador no contesta, el notch no puede quedarse invisible para siempre
  async function mandarMascaras(rects) {
    const ok = await Promise.race([
      enviar({ tipo: 'mascaras', rects, vw: innerWidth, vh: innerHeight }),
      esperar(1500).then(() => 'tarde'),
    ]);
    if (ok === 'tarde') console.warn('[Plogy] el grabador tardó en confirmar la máscara');
  }

  // En pantalla completa el navegador solo pinta el elemento que está en pantalla completa:
  // el notch tiene que vivir adentro de ese elemento o no se ve.
  const contenedor = () => document.fullscreenElement || document.body || document.documentElement;

  function reubicarHost() {
    if (host && host.parentNode !== contenedor()) contenedor().append(host);
  }

  // primero la máscara, después lo visible: así nunca queda un cuadro sin tapar
  async function taparYMostrar(cambio, { conPanelAntes = abierto, conPanelDespues = abierto } = {}) {
    await mandarMascaras([...areas(pos, conPanelAntes), ...areas(pos, conPanelDespues)]);
    await esperar(100);
    cambio();
    await esperar(100);
    await mandarMascaras(areas(pos, conPanelDespues));
  }

  // ── posición y arrastre ──

  function limitar(p) {
    const medio = Math.max(BARRA_ANCHO, abierto ? anchoPanel() : 0) / 2;
    return {
      cx: Math.min(Math.max(p.cx, medio + MARGEN), innerWidth - medio - MARGEN),
      y: Math.min(Math.max(p.y, MARGEN), innerHeight - BARRA_ALTO - (abierto ? altoPanel() : 0) - MARGEN),
    };
  }

  function ubicar() {
    el.widget.style.left = `${pos.cx}px`;
    el.widget.style.top = `${pos.y}px`;
  }

  let destino = null;
  let moviendo = false;

  // cada paso del arrastre espera a que el grabador tape la posición vieja y la nueva
  async function moverA(p) {
    destino = limitar(p);
    if (moviendo) return;
    moviendo = true;
    while (destino) {
      const siguiente = destino;
      destino = null;
      await mandarMascaras([...areas(pos, abierto, HOLGURA_ARRASTRE), ...areas(siguiente, abierto, HOLGURA_ARRASTRE)]);
      pos = siguiente;
      if (el.widget) ubicar();
    }
    moviendo = false;
  }

  function empezarArrastre(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const inicio = { x: e.clientX, y: e.clientY, cx: pos.cx, py: pos.y };
    const mover = (ev) => moverA({ cx: inicio.cx + ev.clientX - inicio.x, y: inicio.py + ev.clientY - inicio.y });
    const soltar = async () => {
      removeEventListener('pointermove', mover);
      removeEventListener('pointerup', soltar);
      while (moviendo) await esperar(16);
      await esperar(100);
      await mandarMascaras(areas(pos, abierto));
      chrome.storage.local.set({ posNotch: { cx: pos.cx / innerWidth, y: pos.y } });
    };
    addEventListener('pointermove', mover);
    addEventListener('pointerup', soltar);
  }

  let redimension = null;
  function alRedimensionar() {
    clearTimeout(redimension);
    redimension = setTimeout(() => moverA(pos).then(() => mandarMascaras(areas(pos, abierto))), 60);
  }

  // ── estilos ──

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .widget {
      position: fixed; z-index: 2147483647; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center;
      font: 500 13px/1.45 'Google Sans', 'Helvetica Neue', Arial, sans-serif; color: #fff;
      -webkit-font-smoothing: antialiased;
    }
    .vidrio {
      background: rgba(20, 17, 15, .93);
      backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .4);
    }
    .barra {
      position: relative; z-index: 1;
      width: ${BARRA_ANCHO}px; height: ${BARRA_ALTO}px; border-radius: 16px;
      border: 1px solid rgba(255, 140, 80, .35);
      display: flex; align-items: center; gap: 8px; padding: 0 6px 0 8px;
      cursor: grab; user-select: none;
    }
    .barra:active { cursor: grabbing; }
    .abierto .barra { border-radius: 16px 16px 0 0; border-bottom-color: rgba(255, 255, 255, .06); }
    .asa { color: rgba(255, 255, 255, .35); display: grid; place-items: center; width: 18px; }
    .rec {
      width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
      background: linear-gradient(180deg, #f75946, #ee5358 33%, #e1556a 50%, #c85981 67%, #9c5aa7);
      box-shadow: 0 0 10px rgba(247, 89, 70, .7);
    }
    .ondas { display: flex; align-items: center; gap: 2px; height: 16px; }
    .ondas i { width: 3px; border-radius: 2px; background: #ff8a4c; animation: onda 1s ease-in-out infinite; }
    .ondas i:nth-child(1) { height: 6px; animation-delay: -.2s; }
    .ondas i:nth-child(2) { height: 12px; animation-delay: -.5s; }
    .ondas i:nth-child(3) { height: 16px; animation-delay: -.1s; }
    .ondas i:nth-child(4) { height: 9px; animation-delay: -.7s; }
    @keyframes onda { 50% { transform: scaleY(.35); } }
    .pausado .rec { background: #8a817a; box-shadow: none; }
    .pausado .ondas i { animation: none; transform: scaleY(.25); background: #8a817a; }
    .marca { font-weight: 700; letter-spacing: -.01em; }
    .punto { color: rgba(255, 255, 255, .35); }
    .codigo { color: rgba(255, 255, 255, .75); max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tiempo { font: 500 12.5px ui-monospace, 'SF Mono', Consolas, monospace; color: rgba(255, 255, 255, .85); min-width: 44px; }
    .pausado .tiempo { color: #ffb38a; }
    .acciones { margin-left: auto; display: flex; gap: 2px; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: transparent; }
    button:focus-visible { outline: 2px solid #ffb38a; outline-offset: 2px; }
    .icono { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; transition: background .15s; }
    .icono:hover { background: rgba(255, 255, 255, .1); }
    .icono.guardar { color: #ff8a4c; }
    .icono.chevron svg { transition: transform .2s; }
    .abierto .icono.chevron svg { transform: rotate(180deg); }

    .panel {
      margin-top: -1px; border-radius: 16px; overflow: hidden;
      border: 1px solid rgba(255, 255, 255, .08);
      display: flex; flex-direction: column;
    }
    .panel[hidden] { display: none; }
    .pestanas { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid rgba(255, 255, 255, .07); }
    .pestanas button { padding: 6px 10px 10px; color: rgba(255, 255, 255, .55); border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .pestanas button:hover { color: rgba(255, 255, 255, .85); }
    .pestanas button.activa { color: #fff; font-weight: 700; border-bottom-color: #ff5b00; }
    .cuerpo { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .lineas { flex: 1; overflow-y: auto; padding: 14px 18px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
    .linea { margin: 0 0 8px; color: rgba(255, 255, 255, .9); }
    .linea b { color: #ffb38a; font-weight: 700; }
    .linea small { color: rgba(255, 255, 255, .4); margin-right: 8px; font: 11px ui-monospace, Consolas, monospace; }
    .nota { color: rgba(255, 255, 255, .55); padding: 18px; }
    textarea {
      flex: 1; resize: none; border: 0; outline: none; background: transparent; color: #fff;
      font: inherit; padding: 14px 18px;
    }
    textarea::placeholder { color: rgba(255, 255, 255, .35); }
    .pie {
      display: flex; align-items: center; gap: 12px; padding: 10px 18px;
      border-top: 1px solid rgba(255, 255, 255, .07); font-size: 12px; color: rgba(255, 255, 255, .55);
    }
    .pie span { flex: 1; }
    .pie button { text-decoration: underline; text-underline-offset: 3px; color: rgba(255, 255, 255, .8); font-size: 12px; padding: 0; }
    .pie button:hover { color: #fff; }
    .pie .peligro { color: #ff9a7a; }
  `;

  // ── interfaz ──

  function crear() {
    host = document.createElement('plogy-notch');
    // fuera del flujo: si el contenedor es un grid/flex de Meet, no le mueve el diseño
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    raiz = host.attachShadow({ mode: 'closed' });
    const estilo = document.createElement('style');
    estilo.textContent = CSS;

    el.tiempo = h('span', { class: 'tiempo' });
    el.pausa = h('button', { class: 'icono', title: 'Pausar', onclick: alternarPausa });
    el.widget = h(
      'div',
      { class: 'widget' },
      h(
        'div',
        { class: 'vidrio barra', onpointerdown: empezarArrastre },
        h('span', { class: 'asa', title: 'Arrastrar' }, ICONOS.asa()),
        h('span', { class: 'rec' }),
        h('span', { class: 'ondas' }, h('i'), h('i'), h('i'), h('i')),
        h('span', { class: 'marca' }, 'Plogy'),
        h('span', { class: 'punto' }, '·'),
        // la URL puede ser /abc-defg-hij o /meet/abc-defg-hij: el código es lo último
        h('span', { class: 'codigo' }, location.pathname.split('/').filter(Boolean).pop() || 'Meet'),
        h('span', { class: 'punto' }, '·'),
        el.tiempo,
        h(
          'span',
          { class: 'acciones' },
          el.pausa,
          h('button', { class: 'icono guardar', title: 'Detener y guardar', onclick: guardar }, ICONOS.parar()),
          h('button', { class: 'icono chevron', title: 'Transcripción y notas', onclick: alternarPanel }, ICONOS.chevron())
        )
      ),
      (el.panel = h('div', { class: 'vidrio panel', hidden: true }))
    );

    raiz.append(estilo, el.widget);
    contenedor().append(host);
  }

  function pintarBarra() {
    el.widget.classList.toggle('pausado', !!s.pausado);
    el.widget.classList.toggle('abierto', abierto);
    el.pausa.title = s.pausado ? 'Reanudar' : 'Pausar';
    el.pausa.replaceChildren(s.pausado ? ICONOS.seguir() : ICONOS.pausa());
    el.tiempo.textContent = hms(tiempo());
  }

  function pintarPanel() {
    if (!el.panel) return;
    el.panel.hidden = !abierto;
    if (!abierto) return;
    el.panel.style.width = `${anchoPanel()}px`;
    el.panel.style.height = `${altoPanel()}px`;

    const t = globalThis.PlogyTranscriptor;
    const pestanas = h(
      'div',
      { class: 'pestanas' },
      ...[['transcripcion', 'Transcripción'], ['notas', 'Mis notas']].map(([id, txt]) =>
        h('button', { class: pestana === id ? 'activa' : '', onclick: () => cambiarPestana(id) }, txt)
      )
    );

    let cuerpo;
    if (pestana === 'notas') {
      el.notas = h('textarea', {
        placeholder: 'Escribe tus notas de la reunión… Se guardan con la transcripción.',
        oninput: (e) => guardarNotas(e.target.value),
      });
      el.notas.value = notas;
      cuerpo = h('div', { class: 'cuerpo' }, el.notas);
    } else {
      cuerpo = h('div', { class: 'cuerpo' }, pintarLineas(t));
    }

    const pie = h('div', { class: 'pie' });
    if (confirmando) {
      pie.append(
        h('span', {}, '¿Descartar la grabación? No se guarda nada.'),
        h('button', { class: 'peligro', onclick: descartar }, 'Sí, descartar'),
        h('button', { onclick: () => ((confirmando = false), pintarPanel()) }, 'No')
      );
    } else {
      pie.append(h('span', {}, s.pausado ? 'En pausa · esta ventana no sale en el video.' : 'Grabando la pestaña · esta ventana no sale en el video.'));
      if (t?.activo) pie.append(h('button', { onclick: apagarTranscripcion }, 'Detener transcripción'));
      pie.append(h('button', { class: 'peligro', onclick: () => ((confirmando = true), pintarPanel()) }, 'Descartar'));
    }

    el.panel.replaceChildren(pestanas, cuerpo, pie);
    if (pestana === 'notas') el.notas.focus();
  }

  function pintarLineas(t) {
    const lineas = t?.lineas || [];
    let nota = '';
    if (!s.transcribir) nota = 'La transcripción está apagada en esta grabación.';
    else if (!t?.activo && !lineas.length) nota = 'Transcripción detenida.';
    else if (t?.activo && subtitulosOk === false) nota = 'No encuentro los subtítulos de Meet: actívalos con el botón CC.';
    else if (!lineas.length) nota = s.pausado ? 'En pausa.' : 'Esperando a que alguien hable…';

    const anterior = el.lista;
    const alFinal = !anterior || anterior.scrollHeight - anterior.scrollTop - anterior.clientHeight < 40;
    el.lista = h(
      'div',
      { class: 'lineas' },
      nota ? h('div', { class: 'nota' }, nota) : null,
      lineas.slice(-150).map((l) => h('p', { class: 'linea' }, h('small', {}, hms(l.t)), h('b', {}, `${l.nombre}: `), l.texto))
    );
    requestAnimationFrame(() => {
      if (alFinal) el.lista.scrollTop = el.lista.scrollHeight;
      else if (anterior) el.lista.scrollTop = anterior.scrollTop;
    });
    return el.lista;
  }

  // la transcripción llega seguido: solo se repinta la lista, no todo el panel
  function refrescarLineas() {
    if (!abierto || pestana !== 'transcripcion' || !el.lista) return;
    el.lista.replaceWith(pintarLineas(globalThis.PlogyTranscriptor));
  }

  // ── acciones ──

  async function alternarPausa() {
    await enviar({ tipo: s.pausado ? 'reanudar' : 'pausar' });
  }

  async function guardar() {
    await enviar({ tipo: 'detener' });
  }

  async function descartar() {
    await enviar({ tipo: 'descartar-grabacion' });
  }

  async function alternarPanel() {
    const abrir = !abierto;
    confirmando = false;
    if (abrir) {
      // al abrir puede que el panel no quepa: primero se reubica
      abierto = true;
      const p = limitar(pos);
      abierto = false;
      if (p.cx !== pos.cx || p.y !== pos.y) await moverA(p);
    }
    await taparYMostrar(
      () => {
        abierto = abrir;
        pintarBarra();
        pintarPanel();
      },
      { conPanelAntes: abierto, conPanelDespues: abrir }
    );
  }

  function cambiarPestana(id) {
    pestana = id;
    pintarPanel();
  }

  let guardadoNotas = null;
  function guardarNotas(texto) {
    notas = texto;
    clearTimeout(guardadoNotas);
    guardadoNotas = setTimeout(() => enviar({ tipo: 'notas', sesionId: s?.sesionId, notas }), 800);
  }

  async function apagarTranscripcion() {
    globalThis.PlogyTranscriptor?.detener();
    await enviar({ tipo: 'transcripcion-apagada' });
    pintarPanel();
  }

  // ── ciclo ──

  async function mostrar() {
    if (!host) crear();
    const { posNotch } = await chrome.storage.local.get('posNotch').catch(() => ({}));
    pos = limitar(posNotch ? { cx: posNotch.cx * innerWidth, y: posNotch.y } : { cx: innerWidth / 2, y: MARGEN });
    ubicar();
    pintarBarra();
    pintarPanel();
    host.style.visibility = 'hidden';
    await mandarMascaras(areas(pos, abierto));
    await esperar(120);
    host.style.visibility = '';
    clearInterval(tic);
    tic = setInterval(() => {
      if (!s) return;
      el.tiempo.textContent = hms(tiempo());
      reubicarHost(); // por si Meet movió el DOM o cambió la pantalla completa
    }, 500);
    addEventListener('resize', alRedimensionar);
    document.addEventListener('fullscreenchange', reubicarHost);
    console.info('[Plogy] notch visible', diagnosticoNotch());
  }

  function diagnosticoNotch() {
    if (!host) return { creado: false };
    const r = el.widget.getBoundingClientRect();
    const centro = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      creado: true,
      conectado: host.isConnected,
      padre: host.parentNode?.nodeName,
      pantallaCompleta: document.fullscreenElement?.nodeName || null,
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      visibilidad: getComputedStyle(host).visibility,
      encima: centro === host ? 'notch' : centro ? `${centro.nodeName}.${String(centro.className).slice(0, 40)}` : null,
    };
  }

  function quitar() {
    clearInterval(tic);
    clearTimeout(guardadoNotas);
    removeEventListener('resize', alRedimensionar);
    document.removeEventListener('fullscreenchange', reubicarHost);
    host?.remove();
    host = raiz = null;
    el = {};
    abierto = confirmando = false;
    s = null;
  }

  function iniciar(msg) {
    s = {
      sesionId: msg.sesionId,
      desde: msg.desde,
      pausado: false,
      pausadoDesde: null,
      pausadoTotal: 0,
      transcribir: !!msg.transcribir,
    };
    subtitulosOk = null;
    notas = '';
    pestana = 'transcripcion';
    if (s.transcribir) {
      globalThis.PlogyTranscriptor?.iniciar({
        sesionId: s.sesionId,
        reloj: tiempo,
        alCambiar: refrescarLineas,
        alEstado: (ok) => {
          subtitulosOk = ok;
          refrescarLineas();
        },
      });
    }
    return mostrar();
  }

  function cambiarEstado(msg) {
    if (!s) return;
    Object.assign(s, { pausado: msg.pausado, pausadoDesde: msg.pausadoDesde, pausadoTotal: msg.pausadoTotal });
    const t = globalThis.PlogyTranscriptor;
    if (t?.activo) s.pausado ? t.pausar() : t.reanudar();
    pintarBarra();
    if (pestana !== 'notas') pintarPanel(); // no perder el foco mientras se escribe
  }

  function terminar() {
    const t = globalThis.PlogyTranscriptor;
    const sesionId = s?.sesionId;
    const lineas = t ? (t.activo ? t.detener() : t.lineas) : [];
    const resultado = { ok: true, sesionId, lineas, notas };
    quitar();
    return resultado;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
    if (msg.destino !== 'notch') return;
    switch (msg.tipo) {
      case 'ping':
        responder({ ok: true });
        break;
      case 'iniciar':
        iniciar(msg).then(
          () => responder({ ok: true }),
          (e) => {
            console.error('[Plogy] No se pudo mostrar el notch', e);
            responder({ ok: false, error: e.message });
          }
        );
        return true;
      case 'estado':
        cambiarEstado(msg);
        responder({ ok: true });
        break;
      case 'diagnostico':
        responder({
          ok: true,
          url: location.pathname,
          grabando: !!s,
          notch: diagnosticoNotch(),
          subtitulos: globalThis.PlogyTranscriptor?.diagnostico?.() ?? 'transcriptor no cargado',
        });
        break;
      case 'detener': // guardar: devuelve lo transcrito y las notas
      case 'fin': // la grabación terminó por otro lado (error, descartada)
        responder(terminar());
        break;
    }
  });
})();
