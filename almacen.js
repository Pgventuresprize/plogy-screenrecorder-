// IndexedDB compartido por background, offscreen y popup.
// Cada trozo de video se escribe apenas se graba: si Chrome se cae, la grabación se recupera.

const Almacen = (() => {
  let db = null;

  function abrir() {
    db ??= new Promise((ok, mal) => {
      const req = indexedDB.open('grabador-meet', 2);
      req.onupgradeneeded = (e) => {
        if (e.oldVersion < 1) {
          req.result.createObjectStore('sesiones', { keyPath: 'id' });
          req.result.createObjectStore('partes'); // clave: [sesionId, n]
        }
        if (e.oldVersion < 2) req.result.createObjectStore('transcripciones'); // clave: sesionId
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => mal(req.error);
    });
    return db;
  }

  const valor = (req) =>
    new Promise((ok, mal) => {
      req.onsuccess = () => ok(req.result);
      req.onerror = () => mal(req.error);
    });

  const hecho = (t) =>
    new Promise((ok, mal) => {
      t.oncomplete = () => ok();
      t.onerror = t.onabort = () => mal(t.error);
    });

  const rango = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

  async function escribir(stores, fn) {
    const t = (await abrir()).transaction(stores, 'readwrite');
    fn(t);
    await hecho(t);
  }

  async function leer(store, fn) {
    const t = (await abrir()).transaction(store, 'readonly');
    return valor(fn(t.objectStore(store)));
  }

  return {
    crearSesion: (sesion) => escribir('sesiones', (t) => t.objectStore('sesiones').put(sesion)),

    actualizarSesion: (id, cambios) =>
      escribir('sesiones', (t) => {
        const store = t.objectStore('sesiones');
        store.get(id).onsuccess = (e) => e.target.result && store.put({ ...e.target.result, ...cambios });
      }),

    guardarParte: (id, n, blob) => escribir('partes', (t) => t.objectStore('partes').put(blob, [id, n])),

    obtenerSesion: (id) => leer('sesiones', (s) => s.get(id)),
    listarSesiones: () => leer('sesiones', (s) => s.getAll()),
    leerPartes: (id) => leer('partes', (s) => s.getAll(rango(id))),
    contarPartes: (id) => leer('partes', (s) => s.count(rango(id))),

    guardarTranscripcion: (id, lineas) =>
      escribir('transcripciones', (t) => t.objectStore('transcripciones').put(lineas, id)),
    leerTranscripcion: (id) => leer('transcripciones', (s) => s.get(id)),

    borrarSesion: (id) =>
      escribir(['sesiones', 'partes', 'transcripciones'], (t) => {
        t.objectStore('sesiones').delete(id);
        t.objectStore('partes').delete(rango(id));
        t.objectStore('transcripciones').delete(id);
      }),
  };
})();
