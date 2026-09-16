(function(){
"use strict";

function smooth01(a,b,x){ x=(x-a)/(b-a); x = x<0?0:(x>1?1:x); return x*x*(3-2*x); }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }

/* =========================================================================
   VALUE NOISE  —  shared by the terrain, the dust field and the haze
   ========================================================================= */
function hash3(x,y,z){
  var s = Math.sin(x*127.1 + y*311.7 + z*74.7)*43758.5453;
  return s - Math.floor(s);
}
function vnoise(x,y,z){
  var xi=Math.floor(x), yi=Math.floor(y), zi=Math.floor(z);
  var xf=x-xi, yf=y-yi, zf=z-zi;
  xf=xf*xf*(3-2*xf); yf=yf*yf*(3-2*yf); zf=zf*zf*(3-2*zf);
  function L(a,b,t){return a+(b-a)*t;}
  var c000=hash3(xi,yi,zi),     c100=hash3(xi+1,yi,zi),
      c010=hash3(xi,yi+1,zi),   c110=hash3(xi+1,yi+1,zi),
      c001=hash3(xi,yi,zi+1),   c101=hash3(xi+1,yi,zi+1),
      c011=hash3(xi,yi+1,zi+1), c111=hash3(xi+1,yi+1,zi+1);
  return L(L(L(c000,c100,xf),L(c010,c110,xf),yf), L(L(c001,c101,xf),L(c011,c111,xf),yf), zf);
}
function fbm(x,y,z){
  return 0.55*vnoise(x,y,z) + 0.28*vnoise(x*2.1,y*2.1,z*2.1) + 0.17*vnoise(x*4.3,y*4.3,z*4.3);
}
function n2(x,y){ return vnoise(x, y, 0.37); }

/* =========================================================================
   TERRAIN
   Ridged multifractal through a warped domain: the warp is what stops the
   crests reading as noise and turns them into ranges that overlap in depth.
   ========================================================================= */
function ridged(x,y,oct){
  var a=0.5, f=1, s=0, n=0, i, v;
  for(i=0;i<oct;i++){
    v = 1 - Math.abs(n2(x*f, y*f)*2 - 1);
    v = v*v;
    s += v*a; n += a; a *= 0.52; f *= 2.03;
  }
  return s/n;
}
var TERRAIN_PEAK = 72.0;
function terrainH(x,z){
  var d = -z;
  var rise = smooth01(50, 92, d);          // the sea keeps the near ground clear
  if(rise <= 0) return 0;
  var wx = x + 22.0*(n2(x*0.0060+3.1, z*0.0060-1.7) - 0.5);
  var wz = z + 22.0*(n2(x*0.0060-2.3, z*0.0060+5.9) - 0.5);
  var r  = ridged(wx*0.0062, wz*0.0062, 5);
  var h  = Math.pow(r, 1.50) * TERRAIN_PEAK;
  h *= 0.22 + 1.25*n2(x*0.0029+11, z*0.0029-4);   // cluster peaks into ranges
  h *= 0.72 + 0.55*smooth01(60, 210, d);          // far ranges stand taller
  return h * rise;
}

/* One screen-uniform row grid, reused for the point cloud and the occluder.
   Each row spans exactly the frustum width at its own depth, so the sampling
   density is flat in screen space instead of piling up at the horizon. */
function rowGrid(NX, NZ, dNear, dFar, spread){
  var zs = new Float64Array(NZ), ws = new Float64Array(NZ), j;
  var ratio = dFar/dNear;
  for(j=0;j<NZ;j++){
    var d = dNear * Math.pow(ratio, j/(NZ-1));
    zs[j] = -d;
    ws[j] = d * spread;
  }
  return {NX:NX, NZ:NZ, z:zs, w:ws};
}

function buildTerrain(grid){
  var NX = grid.NX, NZ = grid.NZ, n = NX*NZ;
  var pos = new Float32Array(n*3), nrm = new Float32Array(n*3), rnd = new Float32Array(n);
  var ruf = new Float32Array(n);
  var p = 0, c = 0, i, j, e = 0.45, s = 20240817;
  function rand(){ s = (s*1664525 + 1013904223) & 0x7fffffff; return s/0x7fffffff; }
  for(j=0;j<NZ;j++){
    var z = grid.z[j], W = grid.w[j];
    for(i=0;i<NX;i++){
      var x = (i/(NX-1)*2 - 1) * W;
      // break the lattice so the grid never reads as rows of dots
      var jx = x + (rand()-0.5) * (2*W/NX) * 0.85;
      var jz = z + (rand()-0.5) * Math.abs(z) * 0.012;
      var y  = terrainH(jx, jz);
      var hx = (terrainH(jx+e, jz) - terrainH(jx-e, jz)) / (2*e);
      var hz = (terrainH(jx, jz+e) - terrainH(jx, jz-e)) / (2*e);
      var L  = Math.sqrt(hx*hx + 1 + hz*hz);
      pos[p]=jx; pos[p+1]=y; pos[p+2]=jz;
      nrm[p]=-hx/L; nrm[p+1]=1/L; nrm[p+2]=-hz/L;
      rnd[c]=rand();
      ruf[c]=Math.abs(hx) * (2*W/NX);   // rise to the next sample along the row
      p+=3; c++;
    }
  }
  return {position:pos, normal:nrm, rand:rnd, ruf:ruf, count:c};
}

/* Segments along each row: on the ranges they read as contour lines, on the
   water as swell lines. Which segments survive is decided by a coherent noise
   field rather than a fixed stride, so the links clump into ragged runs with
   bare stretches between them. An unbroken line across every row reads as
   drawn banding — that is exactly what goes wrong on flat ground. */
function rowLineIndex(grid, data, rowStep, keepFn){
  var NX = grid.NX, NZ = grid.NZ, pos = data.position;
  var idx = [], j, i;
  for(j=0;j<NZ;j+=rowStep){
    var base = j*NX;
    for(i=0;i<NX-1;i++){
      var a = base + i;
      if(keepFn(pos[a*3], pos[a*3+1], pos[a*3+2])) { idx.push(a, a+1); }
    }
  }
  return new Uint32Array(idx);
}

/* the ranges earn their contours; the low ground keeps only a scatter */
function keepRidgeLine(x,y,z){
  var high = smooth01(3.5, 24.0, y);
  var n = fbm(x*0.048 + 3.1, y*0.020, z*0.048 - 7.4);
  return n < (0.10 + 0.78*high);
}
/* the swell gets occasional streaks, never a full set of stripes */
function keepSwellLine(x,y,z){
  var n = fbm(x*0.085 + 11.3, 0.0, z*0.085 + 5.7);
  return n < 0.32;
}

/* the same field as a solid, so near ridges hide the ones behind them */
function buildTerrainSolid(grid){
  var NX = grid.NX, NZ = grid.NZ, n = NX*NZ;
  var pos = new Float32Array(n*3);
  var idx = new Uint32Array((NX-1)*(NZ-1)*6);
  var p = 0, e = 0, i, j;
  for(j=0;j<NZ;j++){
    var z = grid.z[j], W = grid.w[j];
    for(i=0;i<NX;i++){
      var x = (i/(NX-1)*2 - 1) * W;
      pos[p]=x; pos[p+1]=terrainH(x,z)-1.40; pos[p+2]=z;   // clear of the points it backs
      p+=3;
    }
  }
  for(j=0;j<NZ-1;j++) for(i=0;i<NX-1;i++){
    var a=j*NX+i, b=j*NX+i+1, cc=(j+1)*NX+i, d=(j+1)*NX+i+1;
    idx[e]=a; idx[e+1]=cc; idx[e+2]=b;
    idx[e+3]=b; idx[e+4]=cc; idx[e+5]=d;
    e+=6;
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.computeVertexNormals();
  return g;
}

/* the sea is a flat lattice; height and normal are solved in the shader */
function buildSea(grid){
  var NX = grid.NX, NZ = grid.NZ, n = NX*NZ;
  var pos = new Float32Array(n*3), rnd = new Float32Array(n);
  var p = 0, c = 0, i, j, s = 991;
  function rand(){ s = (s*1664525 + 1013904223) & 0x7fffffff; return s/0x7fffffff; }
  for(j=0;j<NZ;j++){
    var z = grid.z[j], W = grid.w[j];
    for(i=0;i<NX;i++){
      var x = (i/(NX-1)*2 - 1) * W;
      pos[p]   = x + (rand()-0.5) * (2*W/NX) * 0.9;
      pos[p+1] = 0;
      pos[p+2] = z + (rand()-0.5) * Math.abs(z) * 0.014;
      rnd[c]   = rand();
      p+=3; c++;
    }
  }
  return {position:pos, rand:rnd, count:c};
}

/* =========================================================================
   SCENE
   ========================================================================= */
var DEBUG = /[?&]probe/.test(location.search);
var canvas = document.getElementById('gl');
var renderer = new THREE.WebGLRenderer({canvas:canvas, antialias:false, alpha:false,
  preserveDrawingBuffer:DEBUG, powerPreference:'high-performance'});
renderer.setClearColor(0x000000, 1);
renderer.outputEncoding = THREE.sRGBEncoding;

var scene  = new THREE.Scene();
var FOV = 30;
var camera = new THREE.PerspectiveCamera(FOV, 1, 0.8, 520);

/* Eye height sits just above the swell so the sea opens up under the horizon,
   and the camera is pitched up a touch to drop the waterline to 56% of frame. */
var REST_Y = 1.70, REST_Z = 0.0, PITCH = 0.0321;
var pitchNow = PITCH;
camera.position.set(0, REST_Y, REST_Z);
camera.rotation.set(PITCH, 0, 0);

var world = new THREE.Group();
scene.add(world);

var lowPower = (navigator.hardwareConcurrency || 4) <= 4 ||
               /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* =========================================================================
   SHADER CHUNKS
   ========================================================================= */
var GLSL_WAVES = [
'void addWave(inout float h, inout vec2 g, vec2 p, float t, vec2 dir, float k, float a, float sp){',
'  float ph = dot(dir,p)*k + t*sp;',
'  h += a*sin(ph);',
'  g += dir*(k*a*cos(ph));',
'}',
'float seaHeight(vec2 p, float t, float damp, out vec2 g){',
'  float h = 0.0; g = vec2(0.0);',
'  addWave(h,g,p,t, normalize(vec2( 1.00, 0.10)), 0.26, 0.270,       0.52);',
'  addWave(h,g,p,t, normalize(vec2( 0.82,-0.57)), 0.45, 0.155,       0.70);',
'  addWave(h,g,p,t, normalize(vec2(-0.35, 0.94)), 0.86, 0.082*damp,  0.96);',
'  addWave(h,g,p,t, normalize(vec2( 0.96, 0.28)), 1.62, 0.034*damp,  1.38);',
'  addWave(h,g,p,t, normalize(vec2( 0.20,-0.98)), 2.95, 0.015*damp,  1.92);',
'  return h;',
'}'
].join('\n');

/* one tight, hard-edged sprite for every particle in the scene */
var DOT_FRAG = [
'uniform vec3 uColA, uColB, uColC, uHaze;',
'uniform float uOpacity, uGain, uAirIn;',
'varying float vI;',
'varying float vT;',            // transmittance to this point
'void main(){',
'  vec2 c = gl_PointCoord - 0.5;',
'  float d2 = dot(c,c);',
'  if(d2 > 0.25) discard;',
'  float a = exp(-d2*22.0) - 0.012;',
'  if(a <= 0.0) discard;',
'  float t = clamp(vI*1.2, 0.0, 1.0);',
'  vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.45, t));',
'  col = mix(col, uColC, smoothstep(0.45, 1.0, t));',
// aerial perspective: what the object still sends us, plus the air in front
'  vec3 lit = col * vI * uGain;',
'  vec3 air = uHaze * uAirIn * (1.0 - vT);',
'  gl_FragColor = vec4((lit + air) * a * uOpacity, 1.0);',
'}'
].join('\n');

var LINE_FRAG = [
'uniform vec3 uColA, uColB, uColC, uHaze;',
'uniform float uOpacity, uGain, uAirIn;',
'varying float vI;',
'varying float vT;',
'void main(){',
'  float t = clamp(vI*1.2, 0.0, 1.0);',
'  vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.45, t));',
'  col = mix(col, uColC, smoothstep(0.45, 1.0, t));',
'  vec3 lit = col * vI * uGain;',
'  vec3 air = uHaze * uAirIn * (1.0 - vT);',
'  gl_FragColor = vec4((lit + air) * uOpacity, 1.0);',
'}'
].join('\n');

var COL_DEEP = new THREE.Color(0.014, 0.062, 0.180);
var COL_MID  = new THREE.Color(0.040, 0.300, 0.590);
var COL_HOT  = new THREE.Color(0.260, 0.880, 1.000);
/* the colour the air itself glows: everything fades toward this with depth */
var HAZE     = new THREE.Color(0.085, 0.230, 0.400);

function dotUniforms(size, gain, extra){
  var u = {
    uTime:{value:0}, uDpr:{value:1}, uSize:{value:size}, uPixK:{value:1},
    uOpacity:{value:0}, uGain:{value:gain},
    uHaze:{value:HAZE.clone()}, uAirIn:{value:0.0},
    uColA:{value:COL_DEEP.clone()}, uColB:{value:COL_MID.clone()}, uColC:{value:COL_HOT.clone()}
  };
  for(var k in extra) u[k] = extra[k];
  return u;
}

/* ---------- terrain points ---------- */
var TERRAIN_VERT = [
'attribute vec3 aNrm;',
'attribute float aRnd;',
'uniform float uTime, uDpr, uSize, uPixK, uRimPow, uFog, uLift;',
'varying float vI;',
'varying float vT;',
'void main(){',
'  vec3 p = position;',
'  vec4 mv = modelViewMatrix * vec4(p,1.0);',
'  float dist = -mv.z;',
'  vec3 vd = normalize(-mv.xyz);',
'  vec3 nw = normalize(normalMatrix * aNrm);',
'  float rim = pow(clamp(1.0 - abs(dot(nw, vd)), 0.0, 1.0), uRimPow);',
'  vec3 L = normalize(vec3(0.22, 0.42, 1.0));',
'  float lit = 0.40 + 0.60 * pow(max(dot(nw, L), 0.0), 1.5);',
'  float hgt = 0.15 + 0.85 * smoothstep(1.0, 26.0, p.y);',
'  float snow = smoothstep(23.0, 42.0, p.y);',
'  float fog = exp(-dist * uFog);',
'  vT = fog;',
'  float tw  = 0.80 + 0.35 * fract(aRnd * 37.0);',
'  vI = (0.20*lit + 0.90*rim) * hgt * fog * tw * uLift * (1.0 + 1.7*snow);',
'  gl_Position = projectionMatrix * mv;',
'  float sz = uDpr * uPixK * uSize * (0.72 + rim*0.60);',
'  gl_PointSize = clamp(sz, 1.0, 4.0 * uDpr);',
'}'
].join('\n');

/* ---------- sea points ---------- */
var SEA_VERT = [
'attribute float aRnd;',
'uniform float uTime, uDpr, uSize, uPixK, uOriginZ, uFog, uGlitter;',
'varying float vI;',
'varying float vT;',
GLSL_WAVES,
'void main(){',
'  vec3 p = position;',
'  float dist0 = max(-p.z, 0.5);',   // rows ride with the camera, so -z is the distance
'  float damp = 1.0 - smoothstep(14.0, 62.0, dist0);',
'  vec2 g;',
'  p.y = seaHeight(vec2(p.x, p.z + uOriginZ), uTime, damp, g);',
'  vec3 nrm = normalize(vec3(-g.x, 1.0, -g.y));',
'  vec4 mv = modelViewMatrix * vec4(p,1.0);',
'  float dist = -mv.z;',
'  vec3 vd = normalize(-mv.xyz);',
'  vec3 nw = normalize(normalMatrix * nrm);',
'  vec3 L  = normalize((viewMatrix * vec4(0.05, 0.24, -1.0, 0.0)).xyz);',
'  float facing = pow(max(dot(nw, L), 0.0), 2.0);',
'  float spec   = pow(max(dot(reflect(-L, nw), vd), 0.0), 30.0);',
'  float crest  = smoothstep(0.03, 0.26, p.y);',
'  float fog    = exp(-dist * uFog);',
'  vT = fog;',
'  float tw     = 0.75 + 0.45 * fract(aRnd * 53.0);',
'  vI = (0.045 + 0.34*facing + uGlitter*spec + 0.50*crest) * fog * tw;',
'  gl_Position = projectionMatrix * mv;',
'  float sz = uDpr * uPixK * uSize * (0.62 + crest*0.45) * (1.0 + 1.8/max(dist, 9.0));',
'  gl_PointSize = clamp(sz, 1.0, 3.0 * uDpr);',
'}'
].join('\n');

/* =========================================================================
   BUILD
   ========================================================================= */
/* Rows span exactly the frustum at their own depth, so the half-width per unit
   of depth has to track the aspect ratio. Building for a wide frame and then
   viewing it on a phone would leave only a fifth of each row on screen. */
var TAN_HALF = Math.tan(FOV * Math.PI / 360);
function neededSpread(){ return TAN_HALF * (window.innerWidth/window.innerHeight) * 1.06; }
var SPREAD = Math.max(0.20, neededSpread() * 1.14);

/* Sample counts follow the frame too, so a particle sits roughly every 4.6px
   across and every 6px down whatever the window is. That is what keeps the
   lattice reading as scattered points instead of drawn rows. */
var STEP = lowPower ? 5.6 : 4.6;
function gridCounts(){
  var w = window.innerWidth, h = window.innerHeight;
  return {
    nx: Math.max(60, Math.min(300, Math.round(w / STEP))),
    nzT: Math.max(50, Math.min(130, Math.round(h / (STEP*1.44)))),
    nzS: Math.max(55, Math.min(150, Math.round(h / (STEP*1.30))))
  };
}
var GC = gridCounts();
var terrainGrid = rowGrid(GC.nx, GC.nzT, 46, 235, SPREAD);
var seaGrid     = rowGrid(GC.nx, GC.nzS, 3.2,  95, SPREAD);

var terrainData = buildTerrain(terrainGrid);
var seaData     = buildSea(seaGrid);

function pointsFrom(attrs, material, order){
  var g = new THREE.BufferGeometry();
  for(var k in attrs) g.setAttribute(k, new THREE.BufferAttribute(attrs[k].a, attrs[k].n));
  var pts = new THREE.Points(g, material);
  pts.frustumCulled = false;
  pts.renderOrder = order;
  return pts;
}

var terrainMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms(1.05, 62.0, {
    uRimPow:{value:1.40}, uFog:{value:0.0068}, uLift:{value:1.0}
  }),
  vertexShader:TERRAIN_VERT, fragmentShader:DOT_FRAG,
  transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
});
var terrainPts = pointsFrom({
  position:{a:terrainData.position,n:3}, aNrm:{a:terrainData.normal,n:3}, aRnd:{a:terrainData.rand,n:1}
}, terrainMat, 20);
world.add(terrainPts);

var seaMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms(0.86, 17.0, {
    uOriginZ:{value:0}, uFog:{value:0.0180}, uGlitter:{value:1.05}
  }),
  vertexShader:SEA_VERT, fragmentShader:DOT_FRAG,
  transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
});
seaMat.uniforms.uColA.value.setRGB(0.020, 0.085, 0.210);
terrainMat.uniforms.uAirIn.value = 1.15;   // ranges sit deepest in the air
seaMat.uniforms.uAirIn.value     = 0.30;
var seaGroup = new THREE.Group();
var seaPts = pointsFrom({position:{a:seaData.position,n:3}, aRnd:{a:seaData.rand,n:1}}, seaMat, 21);
seaGroup.add(seaPts);
world.add(seaGroup);

/* ---------- connecting lines ----------------------------------------------
   New geometries, but the vertex attributes are the very same BufferAttribute
   objects as the point clouds; only the index differs. Sharing the geometry
   outright would force the points through the line index and draw them twice.
   -------------------------------------------------------------------------- */
function lineGeometry(attrs, grid, data, step, keepFn){
  var g = new THREE.BufferGeometry();
  for(var k in attrs) g.setAttribute(k, attrs[k]);
  g.setIndex(new THREE.BufferAttribute(rowLineIndex(grid, data, step, keepFn), 1));
  return g;
}

/* break the line where the ground rears up: a segment strung across a cliff
   face reads as a glitch, not as terrain */
var TERRAIN_LINE_VERT = TERRAIN_VERT
  .replace("'attribute float aRnd;',", "'attribute float aRnd;',\n'attribute float aRuf;',")
  .replace("'  vI = (0.20*lit + 0.90*rim) * hgt * fog * tw * uLift * (1.0 + 1.7*snow);',",
           "'  vI = (0.20*lit + 0.90*rim) * hgt * fog * tw * uLift * (1.0 + 1.7*snow)',\n" +
           "'     * (1.0 - smoothstep(0.85, 3.2, aRuf))',\n" +
           "'     * (0.30 + 1.35*fract(aRnd*91.0));',");

var terrainLineMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms(1.0, 5.5, {
    uRimPow:{value:1.40}, uFog:{value:0.0068}, uLift:{value:1.0}
  }),
  vertexShader:TERRAIN_LINE_VERT, fragmentShader:LINE_FRAG,
  transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
});
terrainLineMat.uniforms.uAirIn.value = 0.10;
var terrainLines = new THREE.LineSegments(lineGeometry({
  position: terrainPts.geometry.attributes.position,
  aNrm:     terrainPts.geometry.attributes.aNrm,
  aRnd:     terrainPts.geometry.attributes.aRnd,
  aRuf:     new THREE.BufferAttribute(terrainData.ruf, 1)
}, terrainGrid, terrainData, 1, keepRidgeLine), terrainLineMat);
terrainLines.frustumCulled = false;
terrainLines.renderOrder = 18;
world.add(terrainLines);

var seaLineMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms(1.0, 4.2, {
    uOriginZ:{value:0}, uFog:{value:0.0180}, uGlitter:{value:0.45}
  }),
  vertexShader:SEA_VERT, fragmentShader:LINE_FRAG,
  transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
});
seaLineMat.uniforms.uColA.value.setRGB(0.020, 0.085, 0.210);
seaLineMat.uniforms.uAirIn.value = 0.035;
var seaLines = new THREE.LineSegments(lineGeometry({
  position: seaPts.geometry.attributes.position,
  aRnd:     seaPts.geometry.attributes.aRnd
}, seaGrid, seaData, 3, keepSwellLine), seaLineMat);
seaLines.frustumCulled = false;
seaLines.renderOrder = 19;
seaGroup.add(seaLines);

/* ---------- ridges mirrored into the water ---------- */
var REFLECT_VERT = TERRAIN_VERT
  .replace('vec3 p = position;',
           'vec3 p = position;\n  p.y = -p.y * 0.92;\n' +
           '  float rip = sin(p.z*0.35 + uTime*1.15) * 0.22 + sin(p.x*0.62 - uTime*0.8) * 0.14;\n' +
           '  p.x += rip * 0.55; p.y += rip * 0.10;')
  .replace('float hgt = 0.15 + 0.85 * smoothstep(1.0, 26.0, p.y);',
           'float hgt = 0.15 + 0.85 * smoothstep(1.0, 26.0, position.y);')
  .replace('float snow = smoothstep(23.0, 42.0, p.y);',
           'float snow = smoothstep(23.0, 42.0, position.y);')
  .replace('vI = (0.20*lit + 0.90*rim) * hgt * fog * tw * uLift * (1.0 + 1.7*snow);',
           'vI = (0.20*lit + 0.90*rim) * hgt * fog * tw * uLift * (1.0 + 1.7*snow) * smoothstep(0.0, -1.6, p.y);');
var reflectMat = new THREE.ShaderMaterial({
  uniforms: dotUniforms(1.05, 20.0, {
    uRimPow:{value:1.40}, uFog:{value:0.0090}, uLift:{value:1.0}
  }),
  vertexShader:REFLECT_VERT, fragmentShader:DOT_FRAG,
  transparent:true, blending:THREE.AdditiveBlending, depthTest:false, depthWrite:false
});
reflectMat.uniforms.uAirIn.value = 0.35;
var reflectPts = pointsFrom({
  position:{a:terrainData.position,n:3}, aNrm:{a:terrainData.normal,n:3}, aRnd:{a:terrainData.rand,n:1}
}, reflectMat, 8);
world.add(reflectPts);

/* ---------- occluders: near ridges must hide the ranges behind them ---------- */
var solidMat = new THREE.ShaderMaterial({
  uniforms:{ uOpacity:{value:0}, uFog:{value:0.0062},
             uHaze:{value:HAZE.clone()}, uAirIn:{value:0.055} },
  vertexShader:[
    'varying float vD; varying float vY;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
    '  vD = -mv.z; vY = position.y;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n'),
  fragmentShader:[
    'varying float vD; varying float vY; uniform float uOpacity, uFog, uAirIn; uniform vec3 uHaze;',
    'void main(){',
    '  float haze = 1.0 - exp(-vD * uFog);',
    '  vec3 c = vec3(0.0008,0.0020,0.0042) * (1.0 - haze) + uHaze * uAirIn * haze;',
    '  c += vec3(0.0015,0.0045,0.0080) * smoothstep(0.0, 42.0, vY) * (1.0 - haze*0.7);',
    '  gl_FragColor = vec4(c * uOpacity, 1.0);',
    '}'
  ].join('\n'),
  side:THREE.DoubleSide, depthWrite:true, depthTest:true,
  polygonOffset:true, polygonOffsetFactor:1.0, polygonOffsetUnits:6.0
});
var terrainSolid = new THREE.Mesh(buildTerrainSolid(terrainGrid), solidMat);
terrainSolid.frustumCulled = false; terrainSolid.renderOrder = 0;
world.add(terrainSolid);

var seaSolid = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), solidMat);
seaSolid.rotation.x = -Math.PI/2;
seaSolid.position.set(0, -0.62, -300);
seaSolid.frustumCulled = false; seaSolid.renderOrder = 1;
world.add(seaSolid);

/* =========================================================================
   ATMOSPHERE  —  sea mist, high motes, horizon glow
   ========================================================================= */
var DUST_VERT = [
'attribute vec4 aSeed;',
'uniform float uTime, uDpr, uSize, uPixK, uDrift, uFog;',
'varying float vI;',
'varying float vT;',
'void main(){',
'  vec3 p = position;',
'  float ph = aSeed.w*6.2831;',
'  p.x += sin(uTime*0.15 + ph)*uDrift + uTime*uDrift*0.35;',
'  p.y += cos(uTime*0.11 + ph*1.7)*uDrift*0.55;',
'  p.z += sin(uTime*0.09 + ph*2.3)*uDrift;',
'  vec4 mv = modelViewMatrix * vec4(p,1.0);',
'  float dist = -mv.z;',
'  float tw = 0.45 + 0.55*pow(abs(sin(uTime*0.6 + aSeed.x*41.0)), 2.0);',
'  vT = exp(-dist*uFog);',
'  vI = aSeed.y * tw * vT * smoothstep(1.0, 6.0, dist);',
'  gl_Position = projectionMatrix * mv;',
'  float sz = uDpr * uPixK * uSize * aSeed.z * (0.75 + 9.0/max(dist, 5.0));',
'  gl_PointSize = clamp(sz, 1.0, 5.0 * uDpr);',
'}'
].join('\n');

function buildDust(target, seed, cfg){
  var pos = new Float32Array(target*3), rnd = new Float32Array(target*4);
  var s = seed;
  function rand(){ s = (s*1664525 + 1013904223) & 0x7fffffff; return s/0x7fffffff; }
  var c = 0, guard = 0;
  while(c < target && guard < target*120){
    guard++;
    var d = cfg.dNear * Math.pow(cfg.dFar/cfg.dNear, Math.pow(rand(), cfg.dBias));
    var x = (rand()*2-1) * d * SPREAD * 1.05;
    var y = cfg.yMin + rand()*(cfg.yMax - cfg.yMin);
    var z = -d;
    var fall  = Math.exp(-(y - cfg.yMin) / cfg.yFall);
    var clump = Math.pow(fbm(x*cfg.clump + 7, y*cfg.clump*2.2, z*cfg.clump - 3), 2.2);
    if(rand() > fall * (0.15 + 2.4*clump)) continue;
    pos[c*3]=x; pos[c*3+1]=y; pos[c*3+2]=z;
    rnd[c*4]   = rand();
    rnd[c*4+1] = 0.12 + Math.pow(rand(), cfg.briPow)*0.88;
    rnd[c*4+2] = cfg.sizeMin + Math.pow(rand(), 2.2)*cfg.sizeVar;
    rnd[c*4+3] = rand();
    c++;
  }
  return {
    position:new Float32Array(pos.buffer,0,c*3),
    seed:new Float32Array(rnd.buffer,0,c*4),
    count:c
  };
}

function dustLayer(target, seed, cfg, size, gain, drift, fog, colA, colB){
  var d = buildDust(target, seed, cfg);
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position,3));
  g.setAttribute('aSeed',    new THREE.BufferAttribute(d.seed,4));
  var m = new THREE.ShaderMaterial({
    uniforms: dotUniforms(size, gain, {uDrift:{value:drift}, uFog:{value:fog}}),
    vertexShader:DUST_VERT, fragmentShader:DOT_FRAG,
    transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
  });
  m.uniforms.uColA.value.copy(colA);
  m.uniforms.uColB.value.copy(colB);
  var p = new THREE.Points(g,m);
  p.frustumCulled = false; p.renderOrder = 10;
  p.userData.count = d.count;
  return p;
}

var mist = dustLayer(lowPower?3200:6500, 1337,
  {dNear:5, dFar:78, dBias:1.5, yMin:0.05, yMax:5.0, yFall:1.35, clump:0.10, briPow:1.6, sizeMin:0.55, sizeVar:1.35},
  1.30, 1.70, 0.055, 0.0130,
  new THREE.Color(0.030,0.090,0.150), new THREE.Color(0.330,0.720,0.900));

var motes = dustLayer(lowPower?1600:3200, 4711,
  {dNear:6, dFar:110, dBias:1.25, yMin:0.6, yMax:26.0, yFall:11.0, clump:0.055, briPow:3.0, sizeMin:0.45, sizeVar:0.95},
  0.90, 1.70, 0.030, 0.0075,
  new THREE.Color(0.070,0.110,0.185), new THREE.Color(0.620,0.900,1.000));

mist.material.uniforms.uAirIn.value  = 0.10;
motes.material.uniforms.uAirIn.value = 0.02;
world.add(mist); world.add(motes);

/* ---------- horizon glow, sitting behind the far ranges ---------- */
var haze = (function(){
  var m = new THREE.ShaderMaterial({
    uniforms:{uTime:{value:0}, uOpacity:{value:0}},
    vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:[
      'varying vec2 vUv; uniform float uTime, uOpacity;',
      'float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }',
      'float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
      '  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }',
      'void main(){',
      '  vec2 p = (vUv - vec2(0.5, 0.34)) * vec2(2.2, 3.4);',
      '  float t = uTime*0.014;',
      '  float f = 0.58*n(p*1.7+vec2(t,0.0)) + 0.28*n(p*3.6-vec2(0.0,t)) + 0.14*n(p*7.4+t);',
      '  float band = exp(-p.y*p.y*3.4);',
      '  float lift = exp(-max(p.y,0.0)*1.1);',
      '  float side = exp(-p.x*p.x*0.55);',
      '  float a = band * side * (0.30 + f*1.30) + lift*side*0.10*f;',
      '  a *= a;',
      '  vec3 col = mix(vec3(0.012,0.048,0.105), vec3(0.090,0.360,0.560), smoothstep(0.02,0.55,a));',
      '  gl_FragColor = vec4(col * a * uOpacity * 2.10, 1.0);',
      '}'
    ].join('\n'),
    transparent:true, blending:THREE.AdditiveBlending, depthTest:true, depthWrite:false
  });
  var mesh = new THREE.Mesh(new THREE.PlaneGeometry(700, 320), m);
  mesh.position.set(0, 26, -330);
  mesh.frustumCulled = false; mesh.renderOrder = 5;
  return mesh;
})();
world.add(haze);

/* ---------- warp streaks, alive only during the fly-in ---------- */
var streaks = (function(){
  var N = lowPower?700:1700;
  var pos = new Float32Array(N*6);
  var end = new Float32Array(N*2), bri = new Float32Array(N*2), len = new Float32Array(N*2);
  var s = 4242;
  function rand(){ s = (s*1664525 + 1013904223) & 0x7fffffff; return s/0x7fffffff; }
  for(var i=0;i<N;i++){
    var d = 4 + Math.pow(rand(), 1.4) * 70;
    var x = (rand()*2-1) * d * SPREAD * 1.0;
    var y = 0.15 + Math.pow(rand(), 1.8) * 12.0;
    var z = -d;
    pos[i*6]=x; pos[i*6+1]=y; pos[i*6+2]=z;
    pos[i*6+3]=x; pos[i*6+4]=y; pos[i*6+5]=z;
    var b = 0.20 + Math.pow(rand(),2.0)*1.2;
    var l = 0.5 + rand()*2.6;
    end[i*2]=0; end[i*2+1]=1; bri[i*2]=b; bri[i*2+1]=b; len[i*2]=l; len[i*2+1]=l;
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end,1));
  g.setAttribute('aBri', new THREE.BufferAttribute(bri,1));
  g.setAttribute('aLen', new THREE.BufferAttribute(len,1));
  var m = new THREE.ShaderMaterial({
    uniforms:{uWarp:{value:0}, uOpacity:{value:0}},
    vertexShader:[
      'attribute float aEnd, aBri, aLen;',
      'uniform float uWarp;',
      'varying float vA;',
      'void main(){',
      '  vec3 p = position;',
      '  p.z += aEnd * aLen * uWarp;',
      '  vec4 mv = modelViewMatrix * vec4(p,1.0);',
      '  float fade = smoothstep(-90.0,-4.0,mv.z) * (1.0 - smoothstep(-4.0,-0.4,mv.z));',
      '  vA = aBri * fade * (1.0 - aEnd*0.85);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader:[
      'uniform float uOpacity; varying float vA;',
      'void main(){ gl_FragColor = vec4(vec3(0.34,0.76,1.0) * vA * uOpacity, 1.0); }'
    ].join('\n'),
    transparent:true, blending:THREE.AdditiveBlending, depthTest:false, depthWrite:false
  });
  var ls = new THREE.LineSegments(g,m);
  ls.frustumCulled = false; ls.renderOrder = 22;
  return ls;
})();
world.add(streaks);

/* =========================================================================
   POST
   ========================================================================= */
var composer = new THREE.EffectComposer(renderer);
composer.addPass(new THREE.RenderPass(scene, camera));

var bloom = new THREE.UnrealBloomPass(new THREE.Vector2(1,1), 0.82, 0.55, 0.0);
composer.addPass(bloom);

var GradePass = new THREE.ShaderPass({
  uniforms:{ tDiffuse:{value:null}, uTime:{value:0}, uFade:{value:0} },
  vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader:[
    'uniform sampler2D tDiffuse; uniform float uTime, uFade;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  vec2 q = vUv - 0.5;',
    '  float vig = 1.0 - dot(q*vec2(1.02,1.0), q*vec2(1.02,1.0))*1.05;',
    '  c *= clamp(pow(max(vig,0.0), 1.35), 0.0, 1.0);',
    '  c = pow(max(c,0.0), vec3(1.03));',
    '  float g = fract(sin(dot(gl_FragCoord.xy + fract(uTime)*431.0, vec2(12.9898,78.233)))*43758.5453);',
    '  c += (g - 0.5) * 0.016;',
    '  gl_FragColor = vec4(max(c,0.0) * uFade, 1.0);',
    '}'
  ].join('\n')
});
composer.addPass(GradePass);
GradePass.renderToScreen = true;

/* =========================================================================
   RESIZE
   ========================================================================= */
var dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.35 : 1.75);
var DOT_MATS = [terrainMat, seaMat, reflectMat, mist.material, motes.material,
                terrainLineMat, seaLineMat];

function resize(){
  var w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w/h;
  pitchNow = PITCH - 0.075 * clamp((1.35 - camera.aspect)/1.0, 0, 1);
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(dpr);
  renderer.setSize(w,h,false);
  composer.setPixelRatio(dpr);
  composer.setSize(w,h);
  bloom.setSize(w*dpr*0.5, h*dpr*0.5);
  for(var i=0;i<DOT_MATS.length;i++){
    DOT_MATS[i].uniforms.uDpr.value  = dpr;
    DOT_MATS[i].uniforms.uPixK.value = h/720;   // reference frame was 720px tall
  }
}
window.addEventListener('resize', resize);

/* device rotation can outgrow the built spread; rebuild rather than leave the
   scene sitting in a narrow strip down the middle of the frame */
var rebuildTimer = 0;
function rebuildGrids(){
  SPREAD = Math.max(0.20, neededSpread() * 1.14);
  GC = gridCounts();
  terrainGrid = rowGrid(GC.nx, GC.nzT, 46, 235, SPREAD);
  seaGrid     = rowGrid(GC.nx, GC.nzS, 3.2,  95, SPREAD);
  terrainData = buildTerrain(terrainGrid);
  seaData     = buildSea(seaGrid);
  [terrainPts, reflectPts].forEach(function(o){
    o.geometry.setAttribute('position', new THREE.BufferAttribute(terrainData.position,3));
    o.geometry.setAttribute('aNrm',     new THREE.BufferAttribute(terrainData.normal,3));
    o.geometry.setAttribute('aRnd',     new THREE.BufferAttribute(terrainData.rand,1));
  });
  seaPts.geometry.setAttribute('position', new THREE.BufferAttribute(seaData.position,3));
  seaPts.geometry.setAttribute('aRnd',     new THREE.BufferAttribute(seaData.rand,1));
  terrainSolid.geometry.dispose();
  terrainSolid.geometry = buildTerrainSolid(terrainGrid);

  terrainLines.geometry.dispose();
  terrainLines.geometry = lineGeometry({
    position: terrainPts.geometry.attributes.position,
    aNrm:     terrainPts.geometry.attributes.aNrm,
    aRnd:     terrainPts.geometry.attributes.aRnd,
    aRuf:     new THREE.BufferAttribute(terrainData.ruf, 1)
  }, terrainGrid, terrainData, 1, keepRidgeLine);
  seaLines.geometry.dispose();
  seaLines.geometry = lineGeometry({
    position: seaPts.geometry.attributes.position,
    aRnd:     seaPts.geometry.attributes.aRnd
  }, seaGrid, seaData, 3, keepSwellLine);
}
window.addEventListener('resize', function(){
  var gc = gridCounts();
  if(neededSpread() <= SPREAD && gc.nx === GC.nx && gc.nzS === GC.nzS) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildGrids, 260);
});

/* =========================================================================
   POINTER PARALLAX
   ========================================================================= */
var px = 0, py = 0, tx = 0, ty = 0;
window.addEventListener('pointermove', function(e){
  tx = (e.clientX / window.innerWidth  - 0.5) * 2;
  ty = (e.clientY / window.innerHeight - 0.5) * 2;
}, {passive:true});

/* =========================================================================
   LOOP
   ========================================================================= */
var reduceMotion = window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var clock = new THREE.Clock();
var t0 = performance.now();
var INTRO = 2.10;
var START_Z = 40.0, START_Y = 0.62;
function easeOutCubic(x){ return 1 - Math.pow(1-x, 3); }

/* Camera track: hold low and fast over the swell while the streaks rush past,
   then rise and settle into the resting shot. */
var DOLLY = [
  [0.000, 0.000],[0.125, 0.010],[0.250, 0.105],[0.330, 0.215],[0.385, 0.285],
  [0.470, 0.465],[0.585, 0.700],[0.700, 0.884],[0.805, 0.968],[0.900, 0.994],
  [1.000, 1.000]
];
function dollyAt(k){
  if(k <= 0) return 0;
  if(k >= 1) return 1;
  var n = DOLLY.length, i = 0;
  while(i < n-2 && k > DOLLY[i+1][0]) i++;
  var t = (k - DOLLY[i][0]) / (DOLLY[i+1][0] - DOLLY[i][0]);
  var p0 = DOLLY[Math.max(0,i-1)][1], p1 = DOLLY[i][1],
      p2 = DOLLY[i+1][1], p3 = DOLLY[Math.min(n-1,i+2)][1];
  var t2 = t*t, t3 = t2*t;
  return 0.5*((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t2 + (-p0+3*p1-3*p2+p3)*t3);
}

var frames = 0, acc = 0, degraded = false;
var prevCamZ = START_Z;

function step(t, dt){
  var k = Math.min(t / INTRO, 1);
  var e = dollyAt(k);
  var camZ = START_Z + (REST_Z - START_Z) * e;
  var camY = START_Y + (REST_Y - START_Y) * e;
  var speed = (prevCamZ - camZ) / Math.max(dt, 1e-4);
  prevCamZ = camZ;

  var follow = reduceMotion ? 0 : Math.min(1, dt*3.2);
  px += (tx - px) * follow;
  py += (ty - py) * follow;

  camera.position.set(px*0.55, camY - py*0.22 + Math.sin(t*0.23)*0.035, camZ);
  camera.rotation.set(pitchNow*e - 0.012*(1-e) - py*0.010, -px*0.016, 0);

  // sea and mist ride with the camera so the lattice always fills the frame;
  // the wave phase stays world-locked so the swell does not follow you
  seaGroup.position.z = camZ;
  seaMat.uniforms.uOriginZ.value     = camZ;
  seaLineMat.uniforms.uOriginZ.value = camZ;

  var shellFade = smooth01(0.26, 1.00, t);
  var dustFade  = smooth01(0.14, 1.25, t);
  var settle    = Math.min(1, easeOutCubic(Math.max(0, (t-0.45)/1.5)));
  var warp      = 1 - smooth01(0.55, 1.05, t);

  solidMat.uniforms.uOpacity.value    = Math.min(1, shellFade*1.6);
  terrainMat.uniforms.uOpacity.value  = shellFade;
  reflectMat.uniforms.uOpacity.value  = shellFade * settle;
  seaMat.uniforms.uOpacity.value      = shellFade;
  terrainLineMat.uniforms.uOpacity.value = shellFade * settle;
  seaLineMat.uniforms.uOpacity.value     = shellFade * settle;
  mist.material.uniforms.uOpacity.value  = dustFade * (0.35 + 0.65*settle);
  motes.material.uniforms.uOpacity.value = dustFade * (0.35 + 0.65*settle);
  haze.material.uniforms.uOpacity.value  = dustFade * settle;
  streaks.material.uniforms.uOpacity.value = warp * 0.95 * smooth01(0.02, 0.22, t);
  streaks.material.uniforms.uWarp.value    = Math.min(3.4, Math.abs(speed) * 0.09) * warp;

  for(var i=0;i<DOT_MATS.length;i++) DOT_MATS[i].uniforms.uTime.value = t;
  haze.material.uniforms.uTime.value = t;
  GradePass.uniforms.uTime.value = t;
  GradePass.uniforms.uFade.value = Math.min(1, t/0.30);

  bloom.strength = 0.82 + (1-e) * 0.45;
}

function frame(){
  requestAnimationFrame(frame);
  var dt = Math.min(clock.getDelta(), 0.05);
  var t  = (performance.now() - t0) / 1000;
  step(reduceMotion ? INTRO + t*0.15 : t, dt);
  composer.render();

  frames++; acc += dt;
  if(acc > 1.6){
    var fps = frames/acc; frames = 0; acc = 0;
    if(!degraded && fps < 40 && dpr > 1.0){
      dpr = Math.max(1.0, dpr*0.75); degraded = true; resize();
    }
  }
}

resize();
frame();

window.addEventListener('load', function(){ document.body.classList.add('ready'); });
if(document.readyState === 'complete') document.body.classList.add('ready');

/* ---- measurement hooks (only with ?probe) ---- */
if(DEBUG){
  window.__renderAt = function(t){
    tx = ty = px = py = 0;
    prevCamZ = START_Z + (REST_Z-START_Z) * dollyAt(Math.max(0, t-1/60) / INTRO);
    step(t, 1/60);
    composer.render();
    return camera.position.z;
  };
  window.__layers = function(on){
    var m = {terrain:terrainMat, sea:seaMat, reflect:reflectMat,
             tlines:terrainLineMat, slines:seaLineMat,
             mist:mist.material, motes:motes.material, haze:haze.material,
             solid:solidMat, streaks:streaks.material};
    for(var k in m) if(on.hasOwnProperty(k)) m[k].uniforms.uOpacity.value = on[k];
    composer.render();
    return 'ok';
  };
  window.__stats = function(){
    return {terrain:terrainData.count, sea:seaData.count,
            mist:mist.userData.count, motes:motes.userData.count,
            dpr:dpr, w:window.innerWidth, h:window.innerHeight,
            camY:+camera.position.y.toFixed(2), camZ:+camera.position.z.toFixed(2)};
  };
  window.__measure = function(){
    var c = document.createElement('canvas'); c.width=1138; c.height=720;
    var x = c.getContext('2d'); x.drawImage(canvas,0,0,1138,720);
    var D = x.getImageData(0,0,1138,720).data, W=1138;
    function band(y0,y1,x0,x1){
      var r=0,g=0,b=0,n=0,j,i,k;
      for(j=y0;j<y1;j++)for(i=x0;i<x1;i++){k=(j*W+i)*4;r+=D[k];g+=D[k+1];b+=D[k+2];n++;}
      return {L:+((r+g+b)/3/n).toFixed(2), rgb:[+(r/n).toFixed(1),+(g/n).toFixed(1),+(b/n).toFixed(1)]};
    }
    var rows = [];
    for(var y=40;y<720;y+=40) rows.push(y+':'+band(y,y+40,0,1138).L);
    return JSON.stringify({
      sky:   band(60,190,60,1078),
      peaks: band(190,360,180,958),
      horizon:band(380,420,60,1078),
      nearSea:band(560,700,60,1078),
      rows: rows.join(' ')
    });
  };
}
})();
