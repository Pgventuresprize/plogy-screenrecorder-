// Coordina popup ⇄ offscreen (donde vive el MediaRecorder): descarga local, subida a Drive y limpieza.

importScripts('almacen.js');

const OFFSCREEN_URL = 'offscreen.html';
const CARPETA = 'Grabaciones Meet';

const aOffscreen = (msg) => chrome.runtime.sendMessage({ destino: 'offscreen', ...msg });

const driveConfigurado = () => !chrome.runtime.getManifest().oauth2.client_id.startsWith('PEGA_AQUI');

// ── estado (chrome.storage.session sobrevive a que el service worker se duerma) ──

async function leer(clave, porDefecto) {
  const r = await chrome.storage.session.get(clave);
  return r[clave] ?? porDefecto;
}

const leerEstado = () => leer('estado', { grabando: false });
const leerTrabajos = () => leer('trabajos', {}); // sesionId → { nombre, descarga, descargaId, subida, p }

async function guardarEstado(estado) {
  await chrome.storage.session.set({ estado });
  await pintarBadge();
}

async function cambiarTrabajo(id, cambios) {
  const trabajos = await leerTrabajos();
  if (cambios === null) delete trabajos[id];
  else trabajos[id] = { ...trabajos[id], ...cambios };
  await chrome.storage.session.set({ trabajos });
  await pintarBadge();
  return trabajos[id];
}

async function pintarBadge() {
  const estado = await leerEstado();
  const trabajos = Object.values(await leerTrabajos());
  const comprimiendo = trabajos.find((t) => t.compresion === 'comprimiendo');
  const subiendo = trabajos.find((t) => t.subida === 'subiendo');
  if (estado.grabando) {
    await chrome.action.setBadgeText({ text: estado.pausado ? 'II' : 'REC' });
    await chrome.action.setBadgeBackgroundColor({ color: estado.pausado ? '#8a817a' : '#d93025' });
  } else if (comprimiendo) {
    await chrome.action.setBadgeText({ text: `${Math.round((comprimiendo.p || 0) * 100)}%` });
    await chrome.action.setBadgeBackgroundColor({ color: '#9c5aa7' });
  } else if (subiendo) {
    await chrome.action.setBadgeText({ text: `${Math.round((subiendo.p || 0) * 100)}%` });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ── offscreen ──

async function hayOffscreen() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}

async function asegurarOffscreen() {
  if (await hayOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Grabar la pestaña de Meet y el micrófono con MediaRecorder',
  });
}

async function cerrarOffscreenSiSobra() {
  const estado = await leerEstado();
  const trabajos = await leerTrabajos();
  if (!estado.grabando && !Object.keys(trabajos).length && (await hayOffscreen())) {
    await chrome.offscreen.closeDocument();
  }
}

// ── Drive ──

async function tokenDrive({ renovar = false, interactivo = false } = {}) {
  if (renovar) {
    const viejo = await chrome.identity.getAuthToken({ interactive: false }).catch(() => null);
    if (viejo?.token) await chrome.identity.removeCachedAuthToken({ token: viejo.token });
  }
  try {
    return (await chrome.identity.getAuthToken({ interactive: false })).token;
  } catch (e) {
    if (!interactivo) throw e;
    return (await chrome.identity.getAuthToken({ interactive: true })).token;
  }
}

// el resultado llega después como 'subida-lista' / 'subida-error': una subida larga
// no puede depender de que este service worker siga despierto esperando la respuesta
async function subirADrive(id, nombre, texto) {
  await cambiarTrabajo(id, { subida: 'subiendo', p: 0 });
  await aOffscreen({ tipo: 'subir', sesionId: id, nombre, texto });
}

async function terminarSubida({ sesionId: id, nombre, archivo, error }) {
  if (archivo) {
    const { historial = [] } = await chrome.storage.local.get('historial');
    historial.unshift({ nombre, link: archivo.webViewLink, fecha: Date.now() });
    await chrome.storage.local.set({ historial: historial.slice(0, 5), ultimoErrorDrive: null });
    await cambiarTrabajo(id, { subida: 'lista', p: 1 });
  } else {
    console.error('Falló la subida a Drive:', error);
    await cambiarTrabajo(id, { subida: 'error', error });
    await chrome.storage.local.set({ ultimoErrorDrive: { nombre, error, fecha: Date.now() } });
  }
  await cerrarSiTermino(id);
}

// ── notch y transcripción dentro de Meet (notch.js + transcriptor.js) ──

async function iniciarNotch(tabId, datos) {
  const msg = { destino: 'notch', tipo: 'iniciar', ...datos };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // la pestaña de Meet se abrió antes de instalar/recargar la extensión: se inyecta a mano
    await chrome.scripting.executeScript({ target: { tabId }, files: ['transcriptor.js', 'notch.js'] });
    await chrome.tabs.sendMessage(tabId, msg);
  }
}

// guardar: cierra el notch y recoge lo transcrito
async function detenerNotch(estado) {
  if (!estado.enMeet || !estado.tabId) return;
  try {
    const r = await chrome.tabs.sendMessage(estado.tabId, { destino: 'notch', tipo: 'detener' });
    if (r?.sesionId !== estado.sesionId) return;
    if (r.lineas?.length) await Almacen.guardarTranscripcion(estado.sesionId, r.lineas);
    if (r.notas?.trim()) await Almacen.actualizarSesion(estado.sesionId, { notas: r.notas });
  } catch {
    // la pestaña ya se cerró: queda lo último que mandó (máx. 5 s atrás)
  }
}

// la grabación terminó por otro lado (error, descartada): solo quitar el notch
async function cerrarNotch(estado) {
  if (!estado.enMeet || !estado.tabId) return;
  await chrome.tabs.sendMessage(estado.tabId, { destino: 'notch', tipo: 'fin' }).catch(() => {});
}

async function avisarPausaAlNotch(estado) {
  if (!estado.enMeet || !estado.tabId) return;
  const { pausado, pausadoDesde, pausadoTotal } = estado;
  await chrome.tabs
    .sendMessage(estado.tabId, { destino: 'notch', tipo: 'estado', pausado, pausadoDesde, pausadoTotal })
    .catch(() => {});
}

function hms(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

async function textoTranscripcion(id) {
  const lineas = (await Almacen.leerTranscripcion(id)) || [];
  const sesion = await Almacen.obtenerSesion(id);
  const notas = sesion?.notas?.trim();
  if (!lineas.length && !notas) return null;

  // une los turnos seguidos de la misma persona en un solo párrafo
  const turnos = [];
  for (const l of lineas) {
    const ultimo = turnos.at(-1);
    if (ultimo?.nombre === l.nombre) ultimo.texto += ` ${l.texto}`;
    else turnos.push({ ...l });
  }

  const titulo = (sesion?.titulo || 'Google Meet').replace(/^Meet\s*[-–]\s*/i, '');
  const fecha = new Date(sesion?.inicio || Date.now()).toLocaleString('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  return [
    `Transcripción · ${titulo}\n${fecha} · Plogy Screen Recorder (subtítulos de Meet)`,
    ...(notas ? [`── Mis notas ──\n${notas}`] : []),
    ...(lineas.length ? ['── Transcripción ──'] : []),
    ...turnos.map((t) => `[${hms(t.t)}] ${t.nombre}: ${t.texto}`),
  ].join('\n\n') + '\n';
}

async function guardarTranscripcionLocal(nombre, texto) {
  try {
    await chrome.downloads.download({
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(texto)}`,
      filename: `${CARPETA}/${nombre.replace(/\.webm$/, '.txt')}`,
      saveAs: false,
    });
  } catch (e) {
    console.warn('No se pudo guardar la transcripción', e);
  }
}

// solo apaga el "Grabando" si es esta sesión (una recuperada no debe cortar la grabación en curso)
async function terminarGrabacion(id) {
  const estado = await leerEstado();
  if (estado.grabando && estado.sesionId === id) {
    await cerrarNotch(estado); // p. ej. se cortó la captura sin pasar por "Guardar"
    await guardarEstado({ grabando: false });
  }
}

// ── ciclo de una grabación terminada ──

async function procesarGrabacion({ sesionId: id, url, nombre }) {
  await terminarGrabacion(id);
  const texto = await textoTranscripcion(id).catch(() => null);
  const { comprimir = true } = await chrome.storage.local.get('comprimir');

  if (comprimir) {
    // sigue en 'paquete-listo' (guarda el .zip) o 'paquete-error' (guarda el .webm como antes)
    await cambiarTrabajo(id, { nombre, descarga: 'pendiente', subida: 'pendiente', compresion: 'comprimiendo', p: 0 });
    await aOffscreen({ tipo: 'empaquetar', sesionId: id, nombre, texto });
    return;
  }
  await guardarYSubir(id, url, nombre, texto);
}

// texto: transcripción suelta (null si ya va dentro del .zip)
async function guardarYSubir(id, url, nombre, texto) {
  const { drive } = await chrome.storage.local.get('drive');
  const conDrive = !!drive && driveConfigurado();
  await cambiarTrabajo(id, {
    nombre,
    descarga: 'pendiente',
    subida: conDrive ? 'pendiente' : 'no',
    compresion: null,
    p: 0,
  });

  try {
    const descargaId = await chrome.downloads.download({ url, filename: `${CARPETA}/${nombre}`, saveAs: false });
    await cambiarTrabajo(id, { descargaId });
  } catch (e) {
    // si Chrome no acepta el blob en downloads, se abre en una pestaña para guardarlo a mano
    console.warn('downloads falló, abro el video en una pestaña', e);
    await chrome.tabs.create({ url });
    await cambiarTrabajo(id, { descarga: 'pestaña' });
  }

  if (texto) await guardarTranscripcionLocal(nombre, texto);
  if (conDrive) subirADrive(id, nombre, texto);
}

async function paqueteListo({ sesionId: id, url, nombre, antes, despues }) {
  const { compresiones = [] } = await chrome.storage.local.get('compresiones');
  compresiones.unshift({ nombre, antes, despues, fecha: Date.now() });
  await chrome.storage.local.set({ compresiones: compresiones.slice(0, 5) });
  await guardarYSubir(id, url, nombre, null);
}

async function paqueteError({ sesionId: id, url, error }) {
  console.warn('No se pudo comprimir, guardo el video original', error);
  const t = (await leerTrabajos())[id];
  if (!url || !t) return acciones['error-grabacion']({ sesionId: id, error });
  const texto = await textoTranscripcion(id).catch(() => null);
  await guardarYSubir(id, url, t.nombre, texto);
}

// la sesión se borra del disco solo cuando el archivo local quedó guardado y Drive terminó
async function cerrarSiTermino(id) {
  const t = (await leerTrabajos())[id];
  if (!t || t.descarga === 'pendiente' || t.descarga === 'pestaña') return;
  if (t.subida === 'pendiente' || t.subida === 'subiendo') return;

  await aOffscreen({ tipo: 'liberar', sesionId: id });
  // si la descarga falló se conserva para poder recuperarla desde el popup
  if (t.descarga === 'lista') await Almacen.borrarSesion(id);
  await cambiarTrabajo(id, null);
  await cerrarOffscreenSiSobra();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const trabajos = await leerTrabajos();
  const id = Object.keys(trabajos).find((k) => trabajos[k].descargaId === delta.id);
  if (!id) return;
  if (delta.state.current === 'complete') await cambiarTrabajo(id, { descarga: 'lista' });
  else if (delta.state.current === 'interrupted') await cambiarTrabajo(id, { descarga: 'error' });
  else return;
  await cerrarSiTermino(id);
});

// ── mensajes ──

const acciones = {
  async estado() {
    const estado = await leerEstado();
    // si el offscreen murió a mitad de grabación, no quedarse pegado en "Grabando"
    if (estado.grabando && !(await hayOffscreen())) {
      await guardarEstado({ grabando: false });
      return { grabando: false };
    }
    return estado;
  },

  async iniciar(msg) {
    if ((await leerEstado()).grabando) return { ok: false, error: 'Ya hay una grabación en curso.' };
    const sesionId = crypto.randomUUID();
    await asegurarOffscreen();
    const r = await aOffscreen({ tipo: 'iniciar', sesionId, streamId: msg.streamId, mic: msg.mic, titulo: msg.titulo });
    if (!r?.ok) {
      await cerrarOffscreenSiSobra();
      return { ok: false, error: r?.error || 'No se pudo iniciar la grabación.' };
    }
    const desde = Date.now();
    await guardarEstado({
      grabando: true,
      sesionId,
      desde,
      pausado: false,
      pausadoDesde: null,
      pausadoTotal: 0,
      tabId: msg.tabId,
      titulo: msg.titulo,
      sinMic: msg.mic && !r.micOk,
      enMeet: !!msg.esMeet,
      transcribir: !!msg.transcribir,
    });
    // si el notch o la transcripción fallan, la grabación sigue igual
    if (msg.esMeet) {
      await iniciarNotch(msg.tabId, { sesionId, desde, transcribir: !!msg.transcribir }).catch((e) => {
        console.warn('No se pudo mostrar el notch', e);
      });
    }
    return { ok: true };
  },

  async detener() {
    // primero se recogen los últimos subtítulos, después se cierra el video
    await detenerNotch(await leerEstado());
    await aOffscreen({ tipo: 'detener' });
    return { ok: true };
  },

  async pausar() {
    const estado = await leerEstado();
    if (!estado.grabando || estado.pausado) return { ok: false };
    await aOffscreen({ tipo: 'pausar' });
    const nuevo = { ...estado, pausado: true, pausadoDesde: Date.now() };
    await guardarEstado(nuevo);
    await avisarPausaAlNotch(nuevo);
    return { ok: true };
  },

  async reanudar() {
    const estado = await leerEstado();
    if (!estado.grabando || !estado.pausado) return { ok: false };
    await aOffscreen({ tipo: 'reanudar' });
    const nuevo = {
      ...estado,
      pausado: false,
      pausadoDesde: null,
      pausadoTotal: (estado.pausadoTotal || 0) + (Date.now() - estado.pausadoDesde),
    };
    await guardarEstado(nuevo);
    await avisarPausaAlNotch(nuevo);
    return { ok: true };
  },

  // detiene sin guardar nada: el offscreen borra los trozos y responde 'grabacion-cancelada'
  async 'descartar-grabacion'() {
    const estado = await leerEstado();
    if (!estado.grabando) return { ok: false };
    await cerrarNotch(estado);
    await aOffscreen({ tipo: 'cancelar' });
    return { ok: true };
  },

  async 'grabacion-cancelada'({ sesionId }) {
    await terminarGrabacion(sesionId);
    await cambiarTrabajo(sesionId, null);
    await cerrarOffscreenSiSobra();
    return { ok: true };
  },

  // desde notch.js: el notch le dice al grabador qué área tapar en el video
  async mascaras({ rects, vw, vh }) {
    if (!(await leerEstado()).grabando) return { ok: false };
    await aOffscreen({ tipo: 'mascaras', rects, vw, vh });
    return { ok: true };
  },

  // notas que se escriben en el notch (se guardan mientras tanto por si el navegador se cae)
  async notas({ sesionId, notas }) {
    if (sesionId && (await Almacen.obtenerSesion(sesionId))) await Almacen.actualizarSesion(sesionId, { notas });
    return { ok: true };
  },

  async 'transcripcion-apagada'() {
    const estado = await leerEstado();
    if (estado.grabando) await guardarEstado({ ...estado, transcribir: false });
    return { ok: true };
  },

  // desde transcriptor.js
  async transcripcion({ sesionId, lineas }) {
    // si la grabación ya se descartó, no dejar una transcripción huérfana
    if (await Almacen.obtenerSesion(sesionId)) await Almacen.guardarTranscripcion(sesionId, lineas);
    return { ok: true };
  },

  async 'transcriptor-estado'({ sesionId, ok }) {
    const estado = await leerEstado();
    if (estado.grabando && estado.sesionId === sesionId) await guardarEstado({ ...estado, subtitulos: ok });
    return { ok: true };
  },

  async recuperar({ sesionId }) {
    await asegurarOffscreen();
    await cambiarTrabajo(sesionId, { descarga: 'pendiente', subida: 'pendiente' });
    await aOffscreen({ tipo: 'recuperar', sesionId });
    return { ok: true };
  },

  async descartar({ sesionId }) {
    await Almacen.borrarSesion(sesionId);
    return { ok: true };
  },

  async 'conectar-drive'() {
    if (!driveConfigurado()) return { ok: false, error: 'Falta configurar Drive (ver README).' };
    try {
      await tokenDrive({ interactivo: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // desde el offscreen
  async 'token-drive'({ renovar }) {
    try {
      return { token: await tokenDrive({ renovar, interactivo: true }) };
    } catch (e) {
      return { error: e.message };
    }
  },

  async 'grabacion-lista'(msg) {
    await procesarGrabacion(msg);
    return { ok: true };
  },

  async 'progreso-subida'({ sesionId, p }) {
    await cambiarTrabajo(sesionId, { p });
    return { ok: true };
  },

  async 'progreso-compresion'({ sesionId, p }) {
    await cambiarTrabajo(sesionId, { p });
    return { ok: true };
  },

  async 'paquete-listo'(msg) {
    await paqueteListo(msg);
    return { ok: true };
  },

  async 'paquete-error'(msg) {
    await paqueteError(msg);
    return { ok: true };
  },

  async 'subida-lista'(msg) {
    await terminarSubida(msg);
    return { ok: true };
  },

  async 'subida-error'(msg) {
    await terminarSubida(msg);
    return { ok: true };
  },

  async 'error-grabacion'({ sesionId, error }) {
    console.error('Error en la grabación:', error);
    const estado = await leerEstado();
    if (estado.sesionId === sesionId) await detenerNotch(estado);
    await terminarGrabacion(sesionId);
    if (sesionId) await cambiarTrabajo(sesionId, null);
    await cerrarOffscreenSiSobra();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (msg.destino !== 'background' || !acciones[msg.tipo]) return;
  acciones[msg.tipo](msg).then(responder, (e) => responder({ ok: false, error: e.message }));
  return true; // respuesta asíncrona
});
