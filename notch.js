// Notch de controles arriba de Meet mientras se graba: pausar, ver la transcripción en vivo,
// guardar o descartar. No sale en el video: antes de mostrarse le pasa al grabador su área
// exacta y el grabador la tapa cuadro por cuadro (ver conMascaras en offscreen.js).

(() => {
  if (globalThis.__plogyNotch) return; // ya inyectado
  globalThis.__plogyNotch = true;

  // geometría fija: la máscara del video se calcula con estos mismos números
  const MARGEN = 10;
  const ANCHO = 344;
  const ALTO = 44;
  const PANEL_ANCHO = 400;
  const PANEL_ALTO = 300;
  const SEPARACION = 8;
  const HOLGURA = 10; // px extra de máscara alrededor, por si la máscara llega un cuadro tarde

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const enviar = (msg) => chrome.runtime.sendMessage({ destino: 'background', ...msg }).catch(() => null);

  let host = null;
  let raiz = null;
  let s = null; // { sesionId, desde, pausado, pausadoDesde, pausadoTotal, transcribir }
  let panelAbierto = false;
  let confirmando = false;
  let subtitulosOk = null;
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
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
  }

  // ── máscaras: lo que el grabador tapa en el video ──

  const anchoPanel = () => Math.min(PANEL_ANCHO, innerWidth - 32);
  const altoPanel = () => Math.min(PANEL_ALTO, Math.round(innerHeight * 0.5));

  function rectangulos() {
    const r = [{ x: (innerWidth - ANCHO) / 2, y: MARGEN, w: ANCHO, h: ALTO }];
    if (panelAbierto) {
      r.push({ x: (innerWidth - anchoPanel()) / 2, y: MARGEN + ALTO + SEPARACION, w: anchoPanel(), h: altoPanel() });
    }
    return r.map(({ x, y, w, h }) => ({ x: x - HOLGURA, y: y - HOLGURA, w: w + 2 * HOLGURA, h: h + 2 * HOLGURA }));
  }

  // se espera la confirmación y un respiro: así la máscara ya está puesta cuando algo se ve
  async function mandarMascaras() {
    await enviar({ tipo: 'mascaras', rects: rectangulos(), vw: innerWidth, vh: innerHeight });
    await esperar(120);
  }

  let redimension = null;
  function alRedimensionar() {
    clearTimeout(redimension);
    redimension = setTimeout(mandarMascaras, 50);
  }

  // ── íconos ──

  const svg = (d) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONOS = {
    pausa: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
    seguir: svg('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
    texto: svg('<path d="M4 6h16M4 11h16M4 16h10"/>'),
    cerrar: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  };

  // ── interfaz ──

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .vidrio {
      position: fixed; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      background: rgba(23, 19, 16, .84);
      backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, .12);
      box-shadow: 0 10px 30px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .08);
      color: #fff; font: 500 13px/1.4 'Google Sans', 'Helvetica Neue', Arial, sans-serif;
    }
    .notch {
      top: ${MARGEN}px; width: ${ANCHO}px; height: ${ALTO}px; border-radius: 999px;
      display: flex; align-items: center; gap: 2px; padding: 0 6px 0 16px;
    }
    .rec {
      width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
      background: linear-gradient(180deg, #f75946, #ee5358 33%, #e1556a 50%, #c85981 67%, #9c5aa7);
      animation: latido 1.4s ease-in-out infinite;
    }
    .pausado .rec { animation: none; background: #8a817a; }
    @keyframes latido { 50% { transform: scale(.7); opacity: .55; } }
    .tiempo { font-variant-numeric: tabular-nums; margin: 0 8px; min-width: 62px; }
    .pausado .tiempo { color: #ffb38a; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; }
    button:focus-visible { outline: 2px solid #ffb38a; outline-offset: 2px; }
    .icono {
      width: 32px; height: 32px; border-radius: 50%; background: transparent;
      display: grid; place-items: center; flex-shrink: 0; transition: background .15s;
    }
    .icono:hover { background: rgba(255, 255, 255, .12); }
    .icono.activo { background: rgba(255, 255, 255, .2); }
    .guardar {
      margin-left: auto; height: 32px; padding: 0 14px; border-radius: 999px;
      background: #ff5b00; color: #171310; font-weight: 700;
      display: flex; align-items: center; gap: 7px; transition: transform .15s;
    }
    .guardar:hover { transform: translateY(-1px); }
    .guardar i { width: 9px; height: 9px; border-radius: 2px; background: #171310; }
    .pregunta { flex: 1; padding-left: 4px; }
    .si { height: 32px; padding: 0 14px; border-radius: 999px; background: #ff5b00; color: #171310; font-weight: 700; }
    .no { height: 32px; padding: 0 12px; border-radius: 999px; background: transparent; }
    .no:hover { background: rgba(255, 255, 255, .12); }

    .panel {
      top: ${MARGEN + ALTO + SEPARACION}px; border-radius: 20px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .cabecera {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 14px 10px 16px; border-bottom: 1px solid rgba(255, 255, 255, .08);
    }
    .cabecera b { font-weight: 700; letter-spacing: .01em; }
    .apagar {
      height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12px;
      background: rgba(255, 255, 255, .1);
    }
    .apagar:hover { background: rgba(255, 255, 255, .18); }
    .lineas { flex: 1; overflow-y: auto; padding: 10px 16px 14px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
    .linea { margin: 0 0 10px; color: rgba(255, 255, 255, .88); }
    .linea b { color: #ffb38a; font-weight: 700; margin-right: 6px; }
    .linea small { color: rgba(255, 255, 255, .45); margin-right: 6px; font-variant-numeric: tabular-nums; }
    .nota { color: rgba(255, 255, 255, .6); padding: 18px 16px; }
  `;

  function crear() {
    host = document.createElement('plogy-notch');
    raiz = host.attachShadow({ mode: 'closed' });
    raiz.innerHTML = `<style>${CSS}</style><div class="vidrio notch"></div><div class="vidrio panel" hidden></div>`;
    raiz.addEventListener('click', alClic);
    document.documentElement.appendChild(host);
  }

  function pintarNotch() {
    const notch = raiz.querySelector('.notch');
    notch.classList.toggle('pausado', !!s.pausado);
    if (confirmando) {
      notch.innerHTML = `
        <span class="pregunta">¿Descartar la grabación?</span>
        <button class="si" data-a="descartar-si">Descartar</button>
        <button class="no" data-a="descartar-no">No</button>`;
      return;
    }
    notch.innerHTML = `
      <span class="rec"></span>
      <span class="tiempo">${hms(tiempo())}</span>
      <button class="icono" data-a="pausa" title="${s.pausado ? 'Reanudar' : 'Pausar'}">${s.pausado ? ICONOS.seguir : ICONOS.pausa}</button>
      <button class="icono${panelAbierto ? ' activo' : ''}" data-a="panel" title="Transcripción en vivo">${ICONOS.texto}</button>
      <button class="guardar" data-a="guardar" title="Detener y guardar"><i></i>Guardar</button>
      <button class="icono" data-a="descartar" title="Descartar grabación">${ICONOS.cerrar}</button>`;
  }

  function pintarPanel() {
    const panel = raiz?.querySelector('.panel');
    if (!panel) return;
    panel.hidden = !panelAbierto;
    if (!panelAbierto) return;
    panel.style.width = `${anchoPanel()}px`;
    panel.style.height = `${altoPanel()}px`;

    const activo = globalThis.PlogyTranscriptor?.activo;
    const lineas = globalThis.PlogyTranscriptor?.lineas || [];
    let nota = '';
    if (!s.transcribir) nota = 'La transcripción está apagada en esta grabación.';
    else if (!activo) nota = lineas.length ? '' : 'Transcripción detenida.';
    else if (subtitulosOk === false) nota = 'No encuentro los subtítulos de Meet: actívalos con el botón CC.';
    else if (!lineas.length) nota = s.pausado ? 'En pausa.' : 'Esperando a que alguien hable…';

    const lista = panel.querySelector('.lineas');
    const alFinal = !lista || lista.scrollHeight - lista.scrollTop - lista.clientHeight < 40;

    panel.innerHTML = `
      <div class="cabecera">
        <b>Transcripción en vivo</b>
        ${activo ? '<button class="apagar" data-a="apagar-transcripcion">Detener transcripción</button>' : ''}
      </div>
      ${nota ? `<div class="nota"></div>` : ''}
      <div class="lineas"></div>`;
    if (nota) panel.querySelector('.nota').textContent = nota;

    const nueva = panel.querySelector('.lineas');
    for (const l of lineas.slice(-150)) {
      const p = document.createElement('p');
      p.className = 'linea';
      p.innerHTML = '<small></small><b></b><span></span>';
      p.children[0].textContent = hms(l.t);
      p.children[1].textContent = l.nombre;
      p.children[2].textContent = l.texto;
      nueva.appendChild(p);
    }
    if (alFinal) nueva.scrollTop = nueva.scrollHeight;
    else if (lista) nueva.scrollTop = lista.scrollTop;
  }

  async function mostrar() {
    if (!host) crear();
    host.style.display = 'none';
    pintarNotch();
    await mandarMascaras(); // primero la máscara, después lo visible
    host.style.display = '';
    clearInterval(tic);
    tic = setInterval(() => {
      const t = raiz.querySelector('.tiempo');
      if (t) t.textContent = hms(tiempo());
    }, 500);
    addEventListener('resize', alRedimensionar);
  }

  function quitar() {
    clearInterval(tic);
    removeEventListener('resize', alRedimensionar);
    host?.remove();
    host = raiz = null;
    panelAbierto = confirmando = false;
    s = null;
  }

  async function alternarPanel() {
    if (panelAbierto) {
      panelAbierto = false;
      pintarPanel(); // primero se esconde, después se suelta la máscara
      pintarNotch();
      await mandarMascaras();
    } else {
      panelAbierto = true;
      await mandarMascaras();
      pintarPanel();
      pintarNotch();
    }
  }

  async function alClic(e) {
    const boton = e.target.closest('button[data-a]');
    if (!boton || !s) return;
    switch (boton.dataset.a) {
      case 'pausa':
        await enviar({ tipo: s.pausado ? 'reanudar' : 'pausar' });
        break;
      case 'panel':
        await alternarPanel();
        break;
      case 'guardar':
        boton.disabled = true;
        await enviar({ tipo: 'detener' });
        break;
      case 'descartar':
        confirmando = true;
        pintarNotch();
        break;
      case 'descartar-no':
        confirmando = false;
        pintarNotch();
        break;
      case 'descartar-si':
        await enviar({ tipo: 'descartar-grabacion' });
        break;
      case 'apagar-transcripcion':
        globalThis.PlogyTranscriptor?.detener();
        await enviar({ tipo: 'transcripcion-apagada' });
        pintarPanel();
        break;
    }
  }

  // ── mensajes del background ──

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
    if (s.transcribir) {
      globalThis.PlogyTranscriptor?.iniciar({
        sesionId: s.sesionId,
        reloj: tiempo,
        alCambiar: pintarPanel,
        alEstado: (ok) => {
          subtitulosOk = ok;
          pintarPanel();
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
    pintarNotch();
    pintarPanel();
  }

  function terminar() {
    const t = globalThis.PlogyTranscriptor;
    const sesionId = s?.sesionId;
    const lineas = t ? (t.activo ? t.detener() : t.lineas) : [];
    quitar();
    return { ok: true, sesionId, lineas };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
    if (msg.destino !== 'notch') return;
    switch (msg.tipo) {
      case 'ping':
        responder({ ok: true });
        break;
      case 'iniciar':
        iniciar(msg).then(() => responder({ ok: true }));
        return true;
      case 'estado':
        cambiarEstado(msg);
        responder({ ok: true });
        break;
      case 'detener': // guardar: devuelve lo transcrito
      case 'fin': // la grabación terminó por otro lado (error, descartada)
        responder(terminar());
        break;
    }
  });
})();
