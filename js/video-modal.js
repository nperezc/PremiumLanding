/* Modal de video: el play del hero abre ibague-adentrate en un <dialog>.
   Aislado a propósito — el hero (page.js) y sus animaciones no se tocan.

   <dialog> nativo da gratis: Esc, focus trap básico (showModal), ::backdrop.
   Lo que falta a mano: click en el backdrop (el dialog llena su viewport,
   así que un click que no cae en el frame es click-fuera) y pausar al cerrar.
   Sin JS el botón no hace nada y no hay modal colgado — mejora progresiva.

   Selección de variante (v3): AV1/WebM para navegadores modernos (~9MB vs
   ~11.5MB del MP4 H.264), MP4 como base. AV1 HW-decode solo en GPUs nuevas,
   pero el video es 720p y va en un modal bajo demanda — el costo CPU es
   irrelevante frente al ahorro de red. VP9 no aporta aquí: su encode del
   material salió más pesado y de menor calidad que el H.264 (medido SSIM),
   y Safari no lo reproduce sin AV1 de todos modos.

   Preload de proximidad (v3): con preload="none" nada se descarga hasta el
   play (lo importante), pero el arranque sería frío. `canPlayType` elegido:
   AV1 es soporte binario — si el navegador no lo puede reproducir, no
   descarga nada (la variante equivocada solo se detecta en error de red).
   Un único fetch-progressivo a ~30% en la ronda del botón play: cerca, el
   header del archivo está en cache y el play arranca al instante. */
(function () {
  'use strict';

  var dialog = document.getElementById('video-modal');
  var video = dialog && dialog.querySelector('video');
  var trigger = document.querySelector('.liquid-button--play');
  if (!dialog || !video || !trigger) return;

  /* ── Variante según soporte (elegida una vez) ─────────────────────── */
  var can = video.canPlayType('video/webm; codecs="av01.0.05M.08"');
  var src = can ? 'inner-green-assets/ibague-adentrate-av1.webm'
    : 'inner-green-assets/ibague-adentrate.mp4';
  video.setAttribute('src', src);

  /* ── Preload de proximidad (~30% en la ronda del botón play) ──────── */
  var warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    video.load(); /* empieza el fetch progresivo del recurso ya asignado */
  }
  trigger.addEventListener('pointerenter', warm);
  trigger.addEventListener('focus', warm); /* navegación por teclado */
  trigger.addEventListener('touchstart', warm, { passive: true });

  function open() {
    dialog.showModal();
    video.play().catch(function () { /* autoplay bloqueado: queda en pausa */ });
  }

  function close() {
    video.pause(); /* síncrono: no depende del timing del evento close */
    dialog.close();
  }

  trigger.addEventListener('click', open);
  dialog.querySelector('.video-modal__close').addEventListener('click', close);

  /* Click-fuera: cualquier click cuyo objetivo no viva dentro del frame. */
  dialog.addEventListener('click', function (e) {
    if (!e.target.closest('.video-modal__frame')) close();
  });

  /* Pausa siempre al salir — no debe seguir sonando de fondo.
     cancel: Esc (dispara antes de close); close: cierre nativo restante. */
  dialog.addEventListener('cancel', function () {
    video.pause();
  });
  dialog.addEventListener('close', function () {
    video.pause();
  });
})();
