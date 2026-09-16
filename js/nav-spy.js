/* Scroll-spy del dock: el scroll es el único dueño de is-active.
   Mapping: #combeima → Cañón (sección 2), #nevado → Nevado (sección 3);
   #rutas/#visitar aún no existen como secciones — se activan cuando existan.
   En el hero no hay ningún item activo (estado de reposo del dock).

   En el apilado sticky (desktop) la sección fijada sigue ocupando 100svh
   debajo de la que llega: la sección "actual" es la ÚLTIMA que cruza el
   centro del viewport, no la primera. Por eso el scan elige el último
   tramo en vez de delegar en IO, cuyo callback puede llegar tarde y con
   el estado viejo (carrera clásica con scroll continuo). */
(function () {
  'use strict';

  /* idempotencia: si el script se evalúa dos veces (cache + reinyección en
     pruebas), no duplicar handlers — la última versión es la que manda. */
  if (window.__navSpyInstalled) {
    Array.prototype.forEach.call(
      document.querySelectorAll('.dock a[data-dock]'),
      function (l) {
        var clone = l.cloneNode(true);
        l.parentNode.replaceChild(clone, l);
      }
    );
  }
  window.__navSpyInstalled = true;

  var links = document.querySelectorAll('.dock a[data-dock][href^="#"]:not(.dock-mark)');
  if (!links.length) return;

  var sections = [];
  for (var i = 0; i < links.length; i++) {
    var el = document.getElementById(links[i].hash.slice(1));
    if (el) sections.push({ link: links[i], el: el });
  }
  if (!sections.length) return;

  var current = null;

  function setActive(next) {
    if (next === current) return;
    for (var i = 0; i < links.length; i++) links[i].classList.remove('is-active');
    if (next) next.classList.add('is-active');
    current = next;
  }

  function spy() {
    var mid = window.innerHeight * 0.5;
    var active = null;
    for (var i = 0; i < sections.length; i++) {
      var r = sections[i].el.getBoundingClientRect();
      /* la última sección que aún cubre el centro del viewport gana */
      if (r.top < mid && r.bottom > mid) active = sections[i].link;
    }
    setActive(active);
  }

  /* ── navegación del dock ────────────────────────────────────────────
     El default del anchor depende del estado interno del navegador: si el
     hash ya es el del link (o quedó seteado de una visita anterior), el
     click no hace NADA. Y con secciones sticky hay un segundo bug: Chrome
     devuelve offsetTop de la posición ATASCADA, no la de flujo — por eso
     "volver hacia arriba" no scrolleaba en desktop (el target calculado
     era la posición actual). La posición de flujo correcta se obtiene
     sumando los offsetHeight de los hermanos ANTERIORES del target: los
     sticky conservan su alto de flujo aunque estén pegados. */
  function flowTop(el) {
    /* suma los hermanos ANTERIORES (nunca el propio el): sticky conserva su
       offsetHeight de flujo aunque esté pegado, así que el total es la
       posición de flujo del target en el documento */
    var top = 0, sib = el.previousElementSibling;
    while (sib) {
      /* solo elementos en flujo; los fixed no aportan altura al documento */
      if (sib.nodeType === 1 && getComputedStyle(sib).position !== 'fixed') top += sib.offsetHeight;
      sib = sib.previousElementSibling;
    }
    return top;
  }

  /* Tween propio en vez de depender del smooth del navegador: en varios
     entornos (webviews, Chrome con la pestaña cargada) el smooth nativo se
     arrastra o se estanca al retargetear en medio de otro scroll suave, y el
     click "no hace nada". Nosotros animamos con el easing del sitio y
     cancelamos ante cualquier input del usuario. */
  var flight = null;   // id del tween activo

  function cancelFlight() {
    if (flight) { cancelAnimationFrame(flight); flight = null; }
  }

  function goTo(hash) {
    var el = document.getElementById(hash.slice(1));
    if (!el) return;
    var target = flowTop(el);

    cancelFlight();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo(0, target);
    } else {
      var startY = window.scrollY;
      var dist = target - startY;
      if (Math.abs(dist) < 2) {
        window.scrollTo(0, target);
      } else {
        var t0 = performance.now(), DUR = 900;
        var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };  /* power3.out, el ease-out del hero */
        var step = function (now) {
          var k = Math.min((now - t0) / DUR, 1);
          window.scrollTo(0, startY + dist * easeOut(k));
          flight = k < 1 ? requestAnimationFrame(step) : null;
        };
        flight = requestAnimationFrame(step);
      }
    }

    /* rueda/touch/teclas cancelan el vuelo: el usuario manda */
    ['wheel', 'touchstart', 'keydown'].forEach(function (ev) {
      addEventListener(ev, cancelFlight, { passive: true, once: false });
    });

    if (history.replaceState) history.replaceState(null, '', hash);
  }

  Array.prototype.forEach.call(links, function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      goTo(link.hash);
    });
  });

  var mark = document.querySelector('.dock-mark[data-dock]');
  if (mark) {
    mark.addEventListener('click', function (e) {
      e.preventDefault();
      goTo('#hero');
    });
  }

  var ticking = false;
  addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }, { passive: true });

  addEventListener('resize', spy, { passive: true });
  spy();
})();
