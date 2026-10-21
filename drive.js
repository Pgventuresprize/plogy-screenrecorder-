// Subida a Google Drive. Corre en el offscreen (donde está el video);
// el token lo entrega el background, que es el único con acceso a chrome.identity.

const Drive = (() => {
  const API = 'https://www.googleapis.com';
  const CARPETA = 'Grabaciones Meet';
  const TROZO = 32 * 256 * 1024; // 8 MB; Drive exige múltiplos de 256 KB
  const REINTENTOS = 6;

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  async function token(renovar) {
    const r = await chrome.runtime.sendMessage({ destino: 'background', tipo: 'token-drive', renovar });
    if (!r?.token) throw new Error(r?.error || 'Sin acceso a Google Drive');
    return r.token;
  }

  // si Google responde 401 (token vencido) se pide uno nuevo y se reintenta una vez
  async function pedir(url, opciones = {}) {
    for (const renovar of [false, true]) {
      const t = await token(renovar);
      const res = await fetch(url, {
        ...opciones,
        headers: { ...opciones.headers, Authorization: `Bearer ${t}` },
      });
      if (res.status !== 401) return res;
    }
    throw new Error('Google Drive rechazó el acceso');
  }

  async function exigirOk(res) {
    if (res.ok) return res.json();
    throw new Error(`Drive respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  // con el permiso drive.file solo se ven las carpetas que creó la extensión
  async function carpeta() {
    const q = encodeURIComponent(
      `name='${CARPETA}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const { files } = await exigirOk(await pedir(`${API}/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`));
    if (files.length) return files[0].id;

    const nueva = await pedir(`${API}/drive/v3/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CARPETA, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (await exigirOk(nueva)).id;
  }

  // pregunta a Drive cuánto recibió de verdad tras un corte
  async function reanudar(sesion, total) {
    const res = await pedir(sesion, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
    if (res.ok) return { archivo: await res.json() };
    if (res.status === 308) {
      const rango = res.headers.get('Range');
      return { desde: rango ? Number(rango.split('-')[1]) + 1 : 0 };
    }
    throw new Error(`Drive respondió ${res.status} al reanudar`);
  }

  async function subir(blob, nombre, alAvanzar, tipo = 'video/webm') {
    const padre = await carpeta();

    const inicio = await pedir(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': tipo,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name: nombre, parents: [padre] }),
    });
    if (!inicio.ok) await exigirOk(inicio);
    const sesion = inicio.headers.get('Location');

    let desde = 0;
    let fallos = 0;
    while (true) {
      const hasta = Math.min(desde + TROZO, blob.size);
      let res = null;
      try {
        res = await pedir(sesion, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${desde}-${hasta - 1}/${blob.size}` },
          body: blob.slice(desde, hasta),
        });
      } catch (e) {
        console.warn('Corte subiendo a Drive', e);
      }

      if (res?.ok) {
        alAvanzar(1);
        return res.json();
      }
      if (res?.status === 308) {
        fallos = 0;
        const rango = res.headers.get('Range');
        desde = rango ? Number(rango.split('-')[1]) + 1 : 0;
        alAvanzar(desde / blob.size);
        continue;
      }
      if (res && res.status < 500 && res.status !== 429) await exigirOk(res);

      // corte de red, 5xx o 429: esperar y retomar desde donde Drive diga
      if (++fallos > REINTENTOS) throw new Error('Se cortó la conexión con Drive demasiadas veces');
      await esperar(2000 * 2 ** fallos);
      const r = await reanudar(sesion, blob.size).catch(() => ({ desde }));
      if (r.archivo) {
        alAvanzar(1);
        return r.archivo;
      }
      desde = r.desde;
    }
  }

  return { subir };
})();
