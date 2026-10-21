// ZIP mínimo sin compresión ("store"): el MP4 ya viene comprimido, así que solo se empaqueta.
// Arma el archivo como un Blob de piezas, sin copiar el video en memoria.

const Zip = (() => {
  const TABLA = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  async function crc32(blob) {
    let crc = 0xffffffff;
    const lector = blob.stream().getReader();
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) crc = TABLA[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function fechaDos(d) {
    return {
      hora: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      fecha: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function cabecera(tamano, campos) {
    const buf = new DataView(new ArrayBuffer(tamano));
    let i = 0;
    for (const [bytes, valor] of campos) {
      if (bytes === 4) buf.setUint32(i, valor, true);
      else buf.setUint16(i, valor, true);
      i += bytes;
    }
    return new Uint8Array(buf.buffer);
  }

  // archivos: [{ nombre, blob }]
  async function crear(archivos) {
    const piezas = [];
    const central = [];
    const { hora, fecha } = fechaDos(new Date());
    let offset = 0;

    for (const { nombre, blob } of archivos) {
      if (blob.size >= 0xffffffff) throw new Error(`${nombre} pesa más de 4 GB`);
      const bytesNombre = new TextEncoder().encode(nombre);
      const crc = await crc32(blob);
      const comunes = [
        [2, 20], [2, 0x0800], [2, 0], [2, hora], [2, fecha], // versión, UTF-8, sin compresión
        [4, crc], [4, blob.size], [4, blob.size], [2, bytesNombre.length], [2, 0],
      ];

      piezas.push(cabecera(30, [[4, 0x04034b50], ...comunes]), bytesNombre, blob);
      central.push(
        cabecera(46, [[4, 0x02014b50], [2, 20], ...comunes, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]),
        bytesNombre
      );
      offset += 30 + bytesNombre.length + blob.size;
    }

    const tamanoCentral = central.reduce((s, p) => s + p.length, 0);
    const fin = cabecera(22, [
      [4, 0x06054b50], [2, 0], [2, 0], [2, archivos.length], [2, archivos.length],
      [4, tamanoCentral], [4, offset], [2, 0],
    ]);
    return new Blob([...piezas, ...central, fin], { type: 'application/zip' });
  }

  return { crear };
})();
