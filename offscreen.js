// Documento invisible donde corre la grabación: mezcla audio de la pestaña + micrófono,
// graba con el video de la pestaña y va escribiendo cada trozo en IndexedDB.

const TROZO_MS = 5000;

let recorder = null;
let streams = [];
let audioCtx = null;
let sesionId = null;
let n = 0;
let cola = Promise.resolve();
let cancelada = false;

// áreas a tapar en el video (el notch de Meet y su panel), en px del viewport de la página
let mascaras = { rects: [], vw: 1, vh: 1 };
const COLOR_FONDO = '#202124'; // fondo de Meet

// videos ya armados, esperando descarga y subida
const listos = new Map(); // sesionId → { blob, url }

const MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const avisar = (msg) => chrome.runtime.sendMessage({ destino: 'background', ...msg });

function nombreArchivo(titulo) {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const fecha = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  const slug = (titulo || 'meet')
    .replace(/^Meet\s*[-–]\s*/i, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'meet';
  return `${fecha}_${slug}.webm`;
}

// Pasa cada cuadro por un canvas y pinta encima las máscaras: así los controles que se ven
// en la pestaña no quedan en la grabación.
function conMascaras(pista) {
  const procesador = new MediaStreamTrackProcessor({ track: pista });
  const generador = new MediaStreamTrackGenerator({ kind: 'video' });
  let lienzo = null;
  let ctx = null;

  procesador.readable
    .pipeThrough(
      new TransformStream({
        transform(cuadro, salida) {
          if (!mascaras.rects.length) return salida.enqueue(cuadro);
          const w = cuadro.displayWidth;
          const h = cuadro.displayHeight;
          if (lienzo?.width !== w || lienzo?.height !== h) {
            lienzo = new OffscreenCanvas(w, h);
            ctx = lienzo.getContext('2d');
          }
          ctx.drawImage(cuadro, 0, 0, w, h);

          // el cuadro puede venir escalado o con bandas: se mapea del viewport de la página al video
          const { vw, vh, rects } = mascaras;
          const escala = Math.min(w / vw, h / vh);
          const dx = (w - vw * escala) / 2;
          const dy = (h - vh * escala) / 2;
          ctx.fillStyle = COLOR_FONDO;
          for (const r of rects) ctx.fillRect(dx + r.x * escala, dy + r.y * escala, r.w * escala, r.h * escala);

          const tapado = new VideoFrame(lienzo, { timestamp: cuadro.timestamp });
          cuadro.close();
          salida.enqueue(tapado);
        },
      })
    )
    .pipeTo(generador.writable)
    .catch(() => {}); // termina cuando se corta la captura

  return generador;
}

async function iniciar({ streamId, mic, titulo, sesionId: id }) {
  if (recorder && recorder.state !== 'inactive') return { ok: false, error: 'Ya está grabando.' };

  streams = [];
  cancelada = false;
  mascaras = { rects: [], vw: 1, vh: 1 };
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });
  streams.push(tabStream);

  audioCtx = new AudioContext();
  const mezcla = audioCtx.createMediaStreamDestination();

  if (tabStream.getAudioTracks().length) {
    const fuenteTab = audioCtx.createMediaStreamSource(tabStream);
    fuenteTab.connect(mezcla);
    // capturar la pestaña la silencia: la reenviamos a los parlantes para seguir oyendo la llamada
    fuenteTab.connect(audioCtx.destination);
  }

  let micOk = false;
  if (mic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streams.push(micStream);
      audioCtx.createMediaStreamSource(micStream).connect(mezcla);
      micOk = true;
    } catch (e) {
      console.warn('Sin micrófono, sigo solo con la pestaña', e);
    }
  }

  const video = conMascaras(tabStream.getVideoTracks()[0]);
  streams.push(new MediaStream([video]));
  const salida = new MediaStream([video, ...mezcla.stream.getAudioTracks()]);

  sesionId = id;
  n = 0;
  cola = Promise.resolve();
  await Almacen.crearSesion({
    id,
    titulo,
    nombre: nombreArchivo(titulo),
    inicio: Date.now(),
    estado: 'grabando',
  });

  const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(salida, {
    mimeType,
    videoBitsPerSecond: 1_500_000, // ~700 MB por hora
    audioBitsPerSecond: 128_000,
  });

  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    const parte = n++;
    // en orden, uno tras otro: el webm solo sirve si los trozos quedan seguidos
    cola = cola
      .then(() => Almacen.guardarParte(id, parte, e.data))
      .catch((err) => console.error('No se pudo guardar un trozo', err));
  };
  recorder.onstop = async () => {
    const descartar = cancelada;
    cancelada = false;
    limpiar();
    await cola;
    if (descartar) {
      await Almacen.borrarSesion(id);
      avisar({ tipo: 'grabacion-cancelada', sesionId: id });
      return;
    }
    await finalizar(id);
  };
  recorder.onerror = (e) => {
    limpiar();
    avisar({ tipo: 'error-grabacion', sesionId: id, error: e.error?.message || 'Error del grabador' });
  };
  recorder.start(TROZO_MS);

  // si se cierra la pestaña de Meet, se corta la captura: cerramos y guardamos lo que hay
  tabStream.getVideoTracks()[0].addEventListener('ended', detener);

  return { ok: true, micOk };
}

function detener() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

// MediaRecorder deja fuera del video el tiempo en pausa
function pausar() {
  if (recorder?.state === 'recording') recorder.pause();
}

function reanudar() {
  if (recorder?.state === 'paused') recorder.resume();
}

function cancelar() {
  cancelada = true;
  detener();
}

function limpiar() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  audioCtx?.close();
  audioCtx = null;
  recorder = null;
  sesionId = null;
}

// arma el video con los trozos guardados y se lo pasa al background para descargar/subir
async function finalizar(id, recuperada = false) {
  try {
    const sesion = await Almacen.obtenerSesion(id);
    const partes = await Almacen.leerPartes(id);
    if (!sesion || !partes.length) throw new Error('La grabación está vacía.');

    const blob = new Blob(partes, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    listos.set(id, { blob, url });
    await Almacen.actualizarSesion(id, { estado: 'lista' });

    const nombre = recuperada ? sesion.nombre.replace(/\.webm$/, '_recuperada.webm') : sesion.nombre;
    avisar({ tipo: 'grabacion-lista', sesionId: id, url, nombre });
  } catch (e) {
    avisar({ tipo: 'error-grabacion', sesionId: id, error: e.message });
  }
}

// comprime el webm a MP4 y lo empaqueta en un .zip con la transcripción;
// desde ahí, lo que se descarga y se sube es el zip
async function empaquetar({ sesionId: id, nombre, texto }) {
  const listo = listos.get(id);
  try {
    if (!listo) throw new Error('El video ya no está en memoria.');
    const mp4 = await Compresor.comprimir(listo.blob, (p) =>
      avisar({ tipo: 'progreso-compresion', sesionId: id, p })
    );
    const base = nombre.replace(/\.webm$/, '');
    const archivos = [{ nombre: `${base}.mp4`, blob: mp4 }];
    if (texto) archivos.push({ nombre: `${base}.txt`, blob: new Blob([texto], { type: 'text/plain' }) });
    const zip = await Zip.crear(archivos);

    URL.revokeObjectURL(listo.url);
    const url = URL.createObjectURL(zip);
    listos.set(id, { blob: zip, url });
    avisar({ tipo: 'paquete-listo', sesionId: id, url, nombre: `${base}.zip`, antes: listo.blob.size, despues: zip.size });
  } catch (e) {
    // sin compresión: el background guarda el webm original como antes
    avisar({ tipo: 'paquete-error', sesionId: id, url: listo?.url, error: e.message });
  }
}

async function subir({ sesionId: id, nombre, texto }) {
  try {
    const listo = listos.get(id);
    if (!listo) throw new Error('El video ya no está en memoria.');
    if (texto) {
      // la transcripción va primero (pesa poco); si falla, el video se sube igual
      await Drive.subir(new Blob([texto], { type: 'text/plain' }), nombre.replace(/\.webm$/, '.txt'), () => {}, 'text/plain')
        .catch((e) => console.warn('No se pudo subir la transcripción', e));
    }
    const tipo = nombre.endsWith('.zip') ? 'application/zip' : 'video/webm';
    const archivo = await Drive.subir(
      listo.blob,
      nombre,
      (p) => avisar({ tipo: 'progreso-subida', sesionId: id, p }),
      tipo
    );
    avisar({ tipo: 'subida-lista', sesionId: id, nombre, archivo });
  } catch (e) {
    avisar({ tipo: 'subida-error', sesionId: id, nombre, error: e.message });
  }
}

function liberar({ sesionId: id }) {
  const listo = listos.get(id);
  if (listo) URL.revokeObjectURL(listo.url);
  listos.delete(id);
}

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (msg.destino !== 'offscreen') return;

  const acciones = {
    iniciar: () => iniciar(msg),
    detener: () => (detener(), { ok: true }),
    pausar: () => (pausar(), { ok: true }),
    reanudar: () => (reanudar(), { ok: true }),
    cancelar: () => (cancelar(), { ok: true }),
    mascaras: () => ((mascaras = { rects: msg.rects, vw: msg.vw, vh: msg.vh }), { ok: true }),
    recuperar: () => (finalizar(msg.sesionId, true), { ok: true }),
    subir: () => (subir(msg), { ok: true }),
    empaquetar: () => (empaquetar(msg), { ok: true }),
    liberar: () => (liberar(msg), { ok: true }),
    grabando: () => ({ ok: true, sesionId }),
  };
  const accion = acciones[msg.tipo];
  if (!accion) return;

  Promise.resolve()
    .then(accion)
    .then(responder)
    .catch((e) => {
      if (msg.tipo === 'iniciar') limpiar();
      responder({ ok: false, error: e.message });
    });
  return true;
});
