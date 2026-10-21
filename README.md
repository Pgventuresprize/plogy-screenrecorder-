# Plogy Screen Recorder

Extensión de Chrome y Brave que graba una llamada de Google Meet: video de la pestaña (incluida la pantalla que alguien comparta), audio de todos los participantes y tu micrófono, en un solo archivo `.webm`. Lo guarda en tu PC y, si quieres, lo sube a Google Drive.

## Instalar (una vez)

1. Abre `chrome://extensions` (en Brave: `brave://extensions`).
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. **Cargar extensión sin empaquetar** → elige esta carpeta (`grabador-meet`).
4. Fija el ícono en la barra (pieza de rompecabezas → pin).

> Si ya tenías cargada la versión 1.0, **quítala y vuelve a cargarla**: la 1.1 tiene un ID fijo (`hgmlihbnkkobogdohnefkmgojbhalnmf`) que Google necesita para Drive.

## Usar

1. Entra a la llamada en Meet.
2. Con la pestaña de Meet al frente, clic en el ícono → **Empezar a grabar**.
   - La primera vez se abre una pestaña para dar permiso al micrófono. Dalo, ciérrala y vuelve a pulsar.
3. El ícono muestra `REC` mientras graba. Sigues oyendo la llamada normal.
4. Clic en el ícono → **Detener y guardar**. Si cierras la pestaña de Meet, también se detiene y guarda.

El archivo queda en `Descargas/Grabaciones Meet/AAAA-MM-DD_HH-MM_codigo-reunion.webm`. Con Drive activado, además se sube a la carpeta **Grabaciones Meet** de tu Drive: el ícono muestra el % y el popup deja el link en "Últimas en Drive".

## Transcripción

Con **Transcribir la llamada** activado (viene así por defecto), la extensión prende los subtítulos de Meet y va anotando quién dice qué. Al terminar deja un `.txt` con el mismo nombre del video:

```
[00:00:12] Juan Pérez: Hola a todos, cómo están…

[00:00:20] Ana: Bien, gracias. Empecemos con la agenda…
```

- Los minutos coinciden con el video.
- Si Drive está activado, el `.txt` también se sube a la misma carpeta.
- El idioma es el de los subtítulos de Meet: en Meet → ⋮ → *Configuración* → *Subtítulos*, elige **Español**.
- Los subtítulos se ven en pantalla, así que también quedan en el video.
- Si el popup dice "No encuentro los subtítulos", actívalos a mano con el botón **CC** de Meet.

## Compresión en ZIP

Con **Comprimir en ZIP al terminar** activado (viene así por defecto), al detener la grabación:

1. El video se convierte a **MP4 (H.264, 1080p)** con el codificador del navegador: pasa de ~700 MB/h a ~500 MB/h, y el MP4 sí trae duración, así que se puede adelantar en cualquier reproductor. Para archivos más livianos, en `compresor.js` cambia `ANCHO_MAX` a `1280` y `VIDEO_BPS` a `550_000` (720p, ~300 MB/h).
2. El MP4 y la transcripción (`.txt`) se empaquetan en un solo `.zip` en `Descargas/Grabaciones Meet/`.
3. Si Drive está activado, se sube el `.zip`.

Mientras comprime, el ícono muestra el % en morado. **No cierres el navegador hasta que termine.** Si se cierra, la grabación queda en "Grabaciones sin guardar" para recuperarla. El popup muestra en "Últimos ZIP" cuánto pesaba antes y después.

Si la compresión falla, se guarda el `.webm` original como siempre, así que no se pierde nada.

Para conservar el video original sin comprimir, apaga el interruptor.

## Si Chrome se cierra a mitad de la llamada

La grabación se va escribiendo en disco cada 5 segundos. Si Chrome se cae, se cierra o se apaga el PC, al volver a abrir la extensión aparece **Grabaciones sin guardar** → **Recuperar**. Se pierden como mucho los últimos 5 segundos.

## Conectar Google Drive (una vez, ~10 min)

Google exige que cada extensión tenga sus propias credenciales. Se crean gratis en Google Cloud:

1. Entra a <https://console.cloud.google.com> con la cuenta donde quieres guardar los videos y crea un proyecto (ej. "Plogy Screen Recorder").
2. **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
3. **Google Auth Platform → Branding / Pantalla de consentimiento**: tipo **Externo**, nombre "Plogy Screen Recorder", tu correo como soporte y contacto.
4. **Público (Audience)** → **Publicar app** (pasarla a "En producción"). El permiso que usa (`drive.file`) no requiere verificación de Google, y así no te vuelve a pedir acceso cada 7 días.
5. **Clientes → Crear cliente** → tipo **Extensión de Chrome** → en *ID del elemento* pega:
   ```
   hgmlihbnkkobogdohnefkmgojbhalnmf
   ```
6. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pégalo en `manifest.json`, en `oauth2.client_id`, en lugar de `PEGA_AQUI_TU_CLIENT_ID.apps.googleusercontent.com`.
7. En `chrome://extensions` pulsa **Recargar** en Plogy Screen Recorder.
8. En el popup marca **Subir a Google Drive** y acepta el permiso.

Notas:
- Usa la cuenta de Google con la que tienes iniciada la sesión **en Chrome** (el perfil, no solo Gmail).
- La extensión solo puede ver y tocar los archivos que ella misma sube (`drive.file`), no el resto de tu Drive.
- Si la subida falla, el video igual queda en Descargas y el error aparece en el popup.

## Cosas a saber

- **Pantalla compartida:** sale tal como la ves en Meet. Deja el diseño en "Automático" o "Destacado" y la ventana maximizada para que el texto se lea.
- **Peso:** ~700 MB por hora.
- **El .webm no trae duración** (limitación de Chrome): en algunos reproductores no se puede adelantar. VLC y Drive lo reproducen bien. Para pasarlo a MP4:
  ```
  ffmpeg -i grabacion.webm -c:v libx264 -c:a aac grabacion.mp4
  ```
- **Avisa que estás grabando.** La extensión no notifica a los demás participantes; en Colombia la grabación de voz e imagen es un dato personal (Ley 1581), así que pide el consentimiento al inicio de la llamada.
