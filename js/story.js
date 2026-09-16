/* Story sections (Nevado del Tolima, Cañón del Combeima): transición con
   GSAP + ScrollTrigger.

   El scroll interpola la entrada (scrub suavizado) y el plato hace
   parallax dentro de su marco — en todos los viewports. Sin pin: anclar
   un hijo del grid (position:fixed dentro de la columna) rompía la
   retícula y dejaba huecos muertos al soltarse.

   Mismo idioma que el hero: easings power2/power3.out, solo transform/opacity.
   El estado inicial lo fija gsap.set (el CSS pinta el reposo), así que sin
   JS las secciones se ven completas — mejora progresiva real. Con
   prefers-reduced-motion este módulo no crea ningún trigger. */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.gsap || !window.ScrollTrigger) return;

  gsap.registerPlugin(ScrollTrigger);

  /* ── posición de FLUJO (sticky-immune) ─────────────────────────────
     Al recargar a media página, el navegador restaura el scroll y las
     secciones sticky quedan ATASCADAS (top ~0 o negativo) antes del
     refresh de ScrollTrigger (load tardío, resize, imagen perezosa).
     Si entonces refresca, getBoundingClientRect devuelve la posición de
     viewport del sticky — NO la del documento — y TODOS los start/end
     colapsan a valores corruptos (progress=1 en todo): blur(3px)
     persistente en secciones visibles y parallax que salta.
     Sumar los offsetHeight de los hermanos anteriores da la posición
     real del documento: el sticky conserva su alto de flujo. Mismo truco
     validado en nav-spy.flowTop (bug 5). Los start/end de este módulo
     son funciones que usan esto — se reevalúan en cada refresh y jamás
     miden un elemento atascado. ── */
  function flowTop(el) {
    var top = 0, sib = el.previousElementSibling;
    while (sib) {
      /* los fixed no aportan altura al documento (dock-wrap) */
      if (sib.nodeType === 1 && getComputedStyle(sib).position !== 'fixed') top += sib.offsetHeight;
      sib = sib.previousElementSibling;
    }
    return top;
  }

  /* ── portal reveal de Visitar: el corte escalonado del hero (clip-path
     steps(12) + haz de luz) disparado UNA vez cuando la sección entra en
     viewport. CSS pinta el estado oculto (.js .glass-window) y el corte;
     JS solo arma .is-portal — sin JS o con reduced-motion la imagen se
     ve completa. ── */
  var visitar = document.getElementById('visitar');
  if (visitar) {
    /* contenido editorial del panel (subtítulo, checklist, CTA): entra
       ESCALONADO en el mismo beat que el portal — la cabecera (badge+titular)
       y el vidrio llegan con el scrub del reveal, y la voz del panel entra
       ya asentada, pieza a pieza. Timeline pausada: la dispara el trigger
       de abajo. clearProps al asentarse: el CTA lleva .par-story y los
       inline de GSAP pisan el parallax de puntero (ver bug 8). */
    var copy = visitar.querySelectorAll('.glass-sub, .story-about, .visitar-cta');
    gsap.set(copy, { autoAlpha: 0, y: 24 });
    var copyTl = gsap.to(copy, {
      autoAlpha: 1,
      y: 0,
      ease: 'power2.out',
      duration: .7,
      stagger: .12,
      onComplete: function () {
        gsap.set(copy, { clearProps: 'transform,translate,rotate,scale' });
      },
      paused: true
    });
    ScrollTrigger.create({
      trigger: visitar,
      /* 'top 62%' en coordenadas de flujo: top absoluto − 0.62·vh */
      start: function () { return flowTop(visitar) - window.innerHeight * 0.62; },
      once: true,
      onEnter: function () { visitar.classList.add('is-portal'); copyTl.play(); }
    });
  }

  document.querySelectorAll('.story').forEach(function (section) {
    var rises = section.querySelectorAll('.rise');
    if (!rises.length) return;

    /* ── reveal: interpolado scrubbed mientras la sección entra.
       La costura la resuelve el gradiente compartido del CSS; el copy
       está en marcha antes de que el pie de la sección anterior salga. ── */
    gsap.set(rises, { autoAlpha: 0, y: 42 });
    gsap.to(rises, {
      autoAlpha: 1,
      y: 0,
      ease: 'power2.out',
      stagger: 0.14,
      /* al asentarse el reveal, GSAP entrega el transform al CSS: los estilos
         inline (transform Y las individuales translate/rotate/scale que GSAP
         neutraliza al parsear) pisarían el parallax de puntero (.par-story). */
      onComplete: function () {
        gsap.set(rises, { clearProps: 'transform,translate,rotate,scale' });
      },
      scrollTrigger: {
        trigger: section,
        /* 'top 85%' / 'top 45%' en coordenadas de flujo — sin esto, un
           refresh con la sección atascada corrompe el rango del scrub */
        start: function () { return flowTop(section) - window.innerHeight * 0.85; },
        end: function () { return flowTop(section) - window.innerHeight * 0.45; },
        scrub: 0.6
      }
    });

    /* parallax del plato: la imagen (112% de alto, top -6%) se desliza
       dentro del marco mientras la sección cruza el viewport.
       En la variante glass el colibrí vuela libre (sin marco) con su
       propia animación de flotación — el parallax pelearía con ella. */
    var img = section.querySelector('figure img:not(.glass-bird)');
    if (img) {
      gsap.fromTo(img, { yPercent: -5 }, {
        yPercent: 5,
        ease: 'none',
        scrollTrigger: {
          trigger: section,
          /* 'top bottom' / 'bottom top' en coordenadas de flujo */
          start: function () { return flowTop(section) - window.innerHeight; },
          end: function () { return flowTop(section) + section.offsetHeight; },
          scrub: true
        }
      });
    }
  });

  /* ── profundidad (desktop, donde vive el apilado sticky): mientras la
     sección siguiente recorre el viewport hasta cubrir, la fijada
     retrocede — leve scale + blur + dim, como capas de un diorama.
     fromTo con estado inicial identidad: el reposo sin scroll sigue
     siendo nítido y el efecto es reversible con el scrub. ── */
  gsap.matchMedia().add('(min-width: 901px)', function () {
    /* A/B hook: benchmarks ejecutan depth OFF con index.html?nodepth */
    if (new URLSearchParams(location.search).has('nodepth')) return;
    var stories = gsap.utils.toArray('.story');
    stories.forEach(function (section, i) {
      var next = stories[i + 1];
      if (!next) return;
      gsap.fromTo(section,
        { scale: 1, filter: 'blur(0px) brightness(1)' },
        {
          /* blur 3px: tuneado por benchmark CDP (CPU throttled 6x) —
             blur 6px costaba +33ms en p95 (2 frames a 60Hz); a 3px el
             coste es indistinguible del ruido de medición. */
          scale: 0.95,
          filter: 'blur(3px) brightness(0.92)',
          ease: 'none',
          scrollTrigger: {
            trigger: next,
            /* 'top bottom' / 'top top' en coordenadas de flujo: si el
               refresh ocurre con la pila sticky restaurada (recarga a
               media página), medir el sticky atascado corrompía el rango
               y el blur quedaba pegado en las secciones visibles */
            start: function () { return flowTop(next) - window.innerHeight; },
            end: function () { return flowTop(next); },
            scrub: true
          }
        }
      );
    });
  });
})();
