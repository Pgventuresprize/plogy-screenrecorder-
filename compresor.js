// Re-codifica el .webm de la grabación a MP4 (H.264, máx. 1080p) con el codificador del navegador.
// Pasa de ~700 MB/h a ~500 MB/h y el MP4 sí trae duración (se puede adelantar en cualquier reproductor).

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from './lib/mediabunny.min.mjs';

const ANCHO_MAX = 1920; // 1080p: texto de pantallas compartidas legible
const VIDEO_BPS = 1_000_000;
const AUDIO_BPS = 96_000;

async function convertir(blob, alAvanzar, codec) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const conversion = await Conversion.init({
    input,
    output,
    video: (pista) => ({
      codec,
      bitrate: VIDEO_BPS,
      forceTranscode: true,
      ...(pista.displayWidth > ANCHO_MAX ? { width: ANCHO_MAX } : {}),
    }),
    audio: { bitrate: AUDIO_BPS },
  });

  // si se descarta una pista (p. ej. el audio) mejor fallar que entregar un video mudo
  if (!conversion.isValid || conversion.discardedTracks.length) {
    const motivos = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
    throw new Error(`No se pudo convertir (${motivos || 'sin pistas'})`);
  }

  conversion.onProgress = (p) => alAvanzar(p);
  await conversion.execute();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

globalThis.Compresor = {
  async comprimir(blob, alAvanzar = () => {}) {
    try {
      return await convertir(blob, alAvanzar, 'avc');
    } catch (e) {
      // sin H.264 en este navegador: que elija el códec que tenga
      console.warn('H.264 no disponible, pruebo con otro códec', e);
      return convertir(blob, alAvanzar, undefined);
    }
  },
};
