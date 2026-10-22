const $ = (id) => document.getElementById(id);
const enviar = (msg) => chrome.runtime.sendMessage({ destino: 'background', ...msg });
const driveConfigurado = () => !chrome.runtime.getManifest().oauth2.client_id.startsWith('PEGA_AQUI');

let reloj = null;

function mostrarMensaje(texto, esError = false) {
  $('mensaje').textContent = texto;
  $('mensaje').classList.toggle('error', esError);
}

function formatear(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const fechaCorta = (t) =>
  new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function fila(texto, ...botones) {
  const div = document.createElement('div');
  div.className = 'fila';
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = texto;
  span.title = texto;
  div.append(span, ...botones);
  return div;
}

function boton(texto, alClic) {
  const b = document.createElement('button');
  b.className = 'chico';
  b.textContent = texto;
  b.addEventListener('click', alClic);
  return b;
}

// ── estado principal ──

function pintarEstado(estado) {
  const grabando = !!estado.grabando;
  document.body.classList.toggle('grabando', grabando);
  $('vista-lista').classList.toggle('oculto', grabando);
  $('vista-grabando').classList.toggle('oculto', !grabando);
  const pausado = grabando && !!estado.pausado;
  document.body.classList.toggle('pausado', pausado);
  $('estado-txt').textContent = pausado ? 'En pausa' : grabando ? 'Grabando' : 'Listo';

  clearInterval(reloj);
  if (grabando) {
    $('grabando-de').textContent = estado.titulo || '';
    $('pausa').textContent = pausado ? 'Reanudar' : 'Pausar';
    // tiempo de video: sin contar las pausas
    const tic = () => {
      const hasta = estado.pausado ? estado.pausadoDesde : Date.now();
      $('tiempo').textContent = formatear(hasta - estado.desde - (estado.pausadoTotal || 0));
    };
    tic();
    reloj = setInterval(tic, 1000);

    const t = $('transcripcion-estado');
    t.classList.toggle('oculto', !estado.transcribir);
    t.classList.toggle('ok', estado.subtitulos === true);
    t.classList.toggle('alerta', estado.subtitulos === false);
    t.textContent =
      estado.subtitulos === true
        ? 'Transcribiendo con los subtítulos de Meet'
        : estado.subtitulos === false
          ? 'No encuentro los subtítulos: actívalos con el botón CC de Meet'
          : 'Activando subtítulos…';

    if (estado.errorNotch) mostrarMensaje(`Sin notch ni transcripción. ${estado.errorNotch}`, true);
    if (estado.sinMic) mostrarMensaje('No se pudo usar el micrófono: se graba solo el audio de la llamada.', true);
  }
}

// ── bloques: subidas, recuperables, historial ──

async function pintarBloques() {
  const estado = await enviar({ tipo: 'estado' });
  const { trabajos = {} } = await chrome.storage.session.get('trabajos');
  const { historial = [], ultimoErrorDrive, compresiones = [] } = await chrome.storage.local.get([
    'historial',
    'ultimoErrorDrive',
    'compresiones',
  ]);

  // compresiones y subidas en curso
  const enProceso = Object.values(trabajos).filter((t) => t.compresion === 'comprimiendo' || t.subida === 'subiendo');
  $('subidas').classList.toggle('oculto', !enProceso.length);
  $('subidas-lista').replaceChildren(
    ...enProceso.flatMap((t) => {
      const pct = Math.round((t.p || 0) * 100);
      const que = t.compresion === 'comprimiendo' ? 'Comprimiendo' : 'Subiendo a Drive';
      const barra = document.createElement('div');
      barra.className = 'barra';
      barra.innerHTML = `<div style="width:${pct}%"></div>`;
      return [fila(`${que} · ${pct}% · ${t.nombre || ''}`), barra];
    })
  );

  // últimos zip: cuánto se ahorró
  const mb = (b) => `${Math.round(b / 1e6)} MB`;
  $('zips').classList.toggle('oculto', !compresiones.length);
  $('zips-lista').replaceChildren(
    ...compresiones.map((c) => fila(`${fechaCorta(c.fecha)} · ${mb(c.antes)} → ${mb(c.despues)} · ${c.nombre}`))
  );

  // grabaciones que quedaron en disco sin terminar (Chrome se cerró, descarga cancelada…)
  const sesiones = await Almacen.listarSesiones();
  const huerfanas = sesiones.filter(
    (s) => !(estado.grabando && s.id === estado.sesionId) && !trabajos[s.id]
  );
  $('pendientes').classList.toggle('oculto', !huerfanas.length);
  $('pendientes-lista').replaceChildren(
    ...(await Promise.all(
      huerfanas.map(async (s) => {
        const minutos = Math.max(1, Math.round(((await Almacen.contarPartes(s.id)) * 5) / 60));
        return fila(
          `${fechaCorta(s.inicio)} · ~${minutos} min · ${s.titulo || ''}`,
          boton('Recuperar', async (e) => {
            e.target.disabled = true;
            await enviar({ tipo: 'recuperar', sesionId: s.id });
            mostrarMensaje('Recuperando: el video se guardará en Descargas.');
            pintarBloques();
          }),
          boton('Borrar', async () => {
            await enviar({ tipo: 'descartar', sesionId: s.id });
            pintarBloques();
          })
        );
      })
    ))
  );

  // últimas subidas
  const filasHistorial = historial.map((h) => {
    const a = document.createElement('a');
    a.textContent = 'Abrir';
    a.addEventListener('click', () => chrome.tabs.create({ url: h.link }));
    return fila(`${fechaCorta(h.fecha)} · ${h.nombre}`, a);
  });
  if (ultimoErrorDrive) {
    const f = fila(`No se subió ${ultimoErrorDrive.nombre}: ${ultimoErrorDrive.error}`);
    f.classList.add('error');
    filasHistorial.unshift(f);
  }
  $('historial').classList.toggle('oculto', !filasHistorial.length);
  $('historial-lista').replaceChildren(...filasHistorial);
}

// ── acciones ──

async function pestanaActiva() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function micPermitido() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted';
  } catch {
    return false;
  }
}

async function iniciar() {
  $('iniciar').disabled = true;
  mostrarMensaje('');
  try {
    const tab = await pestanaActiva();
    const mic = $('mic').checked;

    // el documento offscreen no puede pedir permiso de micrófono: se pide una sola vez en una pestaña
    if (mic && !(await micPermitido())) {
      await chrome.tabs.create({ url: 'permisos.html' });
      return;
    }

    // si es Meet lo decide el background preguntándole a la pestaña, no la URL
    const transcribir = $('transcribir').checked;

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await enviar({ tipo: 'iniciar', streamId, tabId: tab.id, titulo: tab.title, mic, transcribir });
    if (!r?.ok) throw new Error(r?.error || 'No se pudo iniciar.');
    pintarEstado(await enviar({ tipo: 'estado' }));
    if (r.errorNotch) mostrarMensaje(`Grabando, pero sin notch ni transcripción. ${r.errorNotch}`, true);
  } catch (e) {
    mostrarMensaje(e.message, true);
  } finally {
    $('iniciar').disabled = false;
  }
}

async function detener() {
  $('detener').disabled = true;
  await enviar({ tipo: 'detener' });
  clearInterval(reloj);
  mostrarMensaje('Guardando el video…');
}

async function cambiarDrive() {
  const activo = $('drive').checked;
  if (activo) {
    mostrarMensaje('Conectando con Google Drive…');
    const r = await enviar({ tipo: 'conectar-drive' });
    if (!r?.ok) {
      $('drive').checked = false;
      return mostrarMensaje(`No se pudo conectar Drive: ${r?.error}`, true);
    }
    mostrarMensaje('Drive conectado. Las grabaciones se subirán solas al terminar.');
  }
  await chrome.storage.local.set({ drive: activo });
}

(async () => {
  $('iniciar').addEventListener('click', iniciar);
  $('detener').addEventListener('click', detener);
  $('diagnostico').addEventListener('click', async () => {
    await enviar({ tipo: 'diagnostico' });
    mostrarMensaje('Listo: diagnostico-meet.json quedó en Descargas › Grabaciones Meet.');
  });
  $('pausa').addEventListener('click', async () => {
    const estado = await enviar({ tipo: 'estado' });
    await enviar({ tipo: estado.pausado ? 'reanudar' : 'pausar' });
  });
  $('drive').addEventListener('change', cambiarDrive);

  // preferencias que se recuerdan entre llamadas (encendidas por defecto)
  const prefs = await chrome.storage.local.get(['transcribir', 'comprimir']);
  for (const clave of ['transcribir', 'comprimir']) {
    $(clave).checked = prefs[clave] ?? true;
    $(clave).addEventListener('change', () => chrome.storage.local.set({ [clave]: $(clave).checked }));
  }

  if (driveConfigurado()) {
    $('drive').checked = !!(await chrome.storage.local.get('drive')).drive;
  } else {
    $('drive').disabled = true;
    $('drive-nota').textContent = 'Falta conectar la cuenta de Google (ver README).';
    $('drive-nota').classList.remove('oculto');
  }

  const estado = await enviar({ tipo: 'estado' });
  pintarEstado(estado);
  pintarBloques();

  chrome.storage.onChanged.addListener(async (cambios) => {
    if (cambios.estado) pintarEstado(cambios.estado.newValue || { grabando: false });
    if (cambios.estado?.oldValue?.grabando && !cambios.estado.newValue?.grabando) {
      mostrarMensaje('Grabación terminada: se está guardando en Descargas.');
    }
    pintarBloques();
  });

  if (!estado.grabando) {
    const tab = await pestanaActiva();
    const esMeet = tab?.url?.startsWith('https://meet.google.com/');
    $('pestana').textContent = esMeet ? tab.title : 'Esta pestaña no es Meet. Igual puedes grabarla.';
    $('pestana').classList.toggle('aviso', !esMeet);
  }
})();
