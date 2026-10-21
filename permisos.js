document.getElementById('permitir').addEventListener('click', async () => {
  const estado = document.getElementById('estado');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    estado.textContent = 'Listo. Cierra esta pestaña, vuelve a Meet y pulsa "Empezar a grabar".';
  } catch {
    estado.textContent = 'Chrome bloqueó el micrófono. Actívalo en el candado de la barra de direcciones y vuelve a intentar.';
  }
});
