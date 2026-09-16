# Architecture — Ibagué site

Behavior-preserving restructure of two monolithic inline HTML files into
engines + pages. Pre-pass originals live under `archive/` (no git history).

## Layout

```
index.html          page shell — markup + wiring only (dock fuera del hero:
                    .dock-wrap fixed, persiste sobre todas las secciones)
canon.html          page shell — detail page
styles/
  site.css          all index styling: design units, dock, choreography, masks
  canon.css         all canon styling
js/
  liquid-metal.js   self-contained WebGL liquid-metal button engine
  page.js           index app: tick bus + pointer state + moss scene + dock
  story.js          story sections: transición GSAP/ScrollTrigger compartida (scrub
                    de reveal + parallax del plato, en todos los viewports, por .story;
                    sin pin — anclar un hijo del grid rompía la retícula y dejaba huecos)
  nav-spy.js        scroll-spy del dock: es el único dueño de is-active
                    (scan rAF en scroll: gana la ÚLTIMA sección que cubre el
                    centro del viewport — en el apilado sticky la fijada sigue
                    ocupando 100svh debajo, así que "última" es la que cubre;
                    nada activo en el hero; mapping #combeima→Cañón,
                    #nevado→Nevado; #rutas/#visitar se activan cuando existan)
  canon-scene.js    canon app: terrain/sea/bloom scene, owns its own loop
inner-green-assets/
  three.min.js      three r150 (index scene)
  gsap.min.js, ScrollTrigger.min.js   GSAP 3.12.5, vendored (story sections)
  ibague.svg         logo ilustrado del dock (paleta propia, tile pálido)
  nevado-tolima-portrait.jpg        foto sección 2 (retrato, del usuario)
  colibri.webp        colibrí sección 2 (crop al bbox con alpha, 85 KB)
  canyon-combeima.jpg  foto sección 3 + fondo desenfocado de la variante glass
  canon-three/      three r147 + postprocessing passes, vendored from the CDN
archive/
  _original/        pre-pass index.html + canon.html, byte-exact
  _generator-scripts/  retired one-shot migration scripts
```

## Boundaries and data flow

| Module | Owns | Never touches |
|---|---|---|
| `js/liquid-metal.js` | its own DOM/window shims, shaders, rAF | page state |
| `js/page.js` interface half | the single rAF tick bus, pointer→`--px/--py` easing, dock + specular state machines, portal reveal | GL scene internals |
| `js/page.js` scene half | renderer/scene/camera, butterfly, moss, spray, scan | DOM styling |
| `js/canon-scene.js` | its own rAF, resize, dpr degradation, bloom, `?probe` hooks | everything else |

```
pointer events ──> page.js interface ──eased state──> CSS vars
                                          └──ndc──> page.js scene ──> canvas
```

Interface owns all pointer listeners; the scene only reads eased values
(`renderer && clock` is the render gate). Both pages respect
`prefers-reduced-motion` independently.

## Verification

`node --check` clean on all engines; all resources served 200; headless Chrome
zero console errors on both pages; A/B screenshot of restructured canon vs the
archived original differed by animation noise only; boot classes
(`is-ready intro-done` / `ready`) confirmed both engines execute.

## Constraints for future passes

- No bundler: classic scripts load in dependency order (three.js → engines,
  GSAP antes de story.js), IIFE-scoped. No introducir módulos ES sin
  decidir un loader.
- Dock/nav: `.dock-wrap` es `position: fixed` (z 50) y NO vive dentro de
  .hero ni de ninguna .story — el motor de profundidad escribe filter/transform
  en las .story, y un ancestro fijo con filter rompería el fixed. El estado
  `is-active` lo posee ÚNICAMENTE js/nav-spy.js: el markup no lleva is-active
  hardcodeado y page.js ya no lo toca (solo hot-clic + polen). En el hero no
  hay ningún item activo. Orden de secciones: hero → #combeima → #nevado.
- Story sections: un solo componente CSS `.story` (+ variantes `.story--flip`
  espejo y `.story--glass` — vidrio oscuro blur 22px + colibrí solapado
  + follaje desenfocado 18px/11px móvil; flotación
  bird-float 3.8s, off en reduced-motion; el parallax de story.js excluye
  .glass-bird porque pelearía con la flotación)
  en site.css; el estado inicial de la entrada lo fija `gsap.set` en
  story.js — el CSS pinta solo el reposo (sin JS/reduced-motion se ve
  todo, sin transiciones CSS que duelan contra el scrub).
  Proporción glass (≥901px, calibrada con sonda a 1600×900): inner 1520u,
  tarjeta 64% de la sección (columnas 68/32, gap 0), colibrí anclado al
  CONTENEDOR de la figura (no a la columna) con left −25% / height 440u ≈
  1.0× la altura de la tarjeta — pico 141px sobre el vidrio, alas/cola
  sangran 7px más allá de la sección pero −8px del viewport (sin corte);
  el glow sigue al ave con insets negativos.
- Apilado cinematográfico (≥901px): cada `.story` mide exactamente 100svh
  y es `position: sticky; top: 0` — la 2 se fija, la 3 desliza por encima
  y queda fija (sticky nativo, no `pin:` de GSAP: anclar un hijo del grid
  rompía la retícula y dejaba huecos). Mientras cubre, la fijada retrocede
  con scale/blur/brightness scrubbed (capa de profundidad en story.js;
  blur 3px — 6px costaba +33ms p95 en benchmark CDP con CPU 6x; el valor
  se puede A/B-ear con index.html?nodepth). En <901px las secciones
  vuelven a flujo normal con su figura 2:3.
- `page.js`'s two halves share IIFE scope by design (the scene reads `ndc`,
  `NARROW`, `clock`); a future split must pass those explicitly.
- `archive/_original/` is the only pre-pass record — treat it as read-only.
- Left as-is on purpose: canon's `lang="en"` and its Figtree/Hanken fonts
  (mismatch with the Lexend brand kit) — a behavior-preserving pass doesn't
  change them; that's a brand-pass decision.
