/* Rishta Connect Global: the 3D stage.
   A WebGL scene (Three.js) sits behind the whole site: an enamelled heart held inside interlocked gold wedding rings, an armillary
   ring, drifting gold petals and fireflies. The camera glides to a new viewpoint on every screen, follows the pointer, the
   scroll and (on phones) the tilt of the device. Cards tilt in CSS 3D.
   The site never depends on this file: if WebGL or Three.js is unavailable, the page keeps its painted night-sky background. */
(function () {
  'use strict';
  const canvas = document.getElementById('stage');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let T = null, ready = false, view = 'home', enabled = true, pulseAt = -9, gyro = false;
  try { enabled = localStorage.getItem('rcg-3d') !== 'off'; } catch (e) { /* storage blocked */ }

  /* where the camera and the heart go for each screen: [camera x,y,z, look-at x,y, heart x,y,scale] */
  const wide = () => innerWidth >= 900;
  const SHOTS = {
    home: () => wide() ? [0, 0.2, 7.5, 1.6, 0, 2.3, 0.1, 1.15] : [0, 0.3, 8.2, 0, -0.2, 0, 1.55, 0.78],
    plans: () => [2.8, 1.0, 7.5, 0, 0, wide() ? 3.4 : 0, wide() ? 0.2 : 2.1, 0.62],
    search: () => [-2.6, 1.6, 8.5, 0, 0, wide() ? -3.8 : 0, wide() ? 0 : 2.4, 0.5],
    brokers: () => [3.6, -0.6, 8.0, 0, 0, wide() ? 3.9 : 0, wide() ? -0.2 : 2.4, 0.5],
    msgs: () => [-3.2, 0.4, 7.2, 0, 0, wide() ? -3.6 : 0, wide() ? 0.2 : 2.4, 0.46],
    profile: () => [0.6, 2.0, 8.0, 0, 0, wide() ? 3.8 : 0, wide() ? 0.4 : 2.4, 0.5],
    pay: () => [0, 0.0, 6.0, 0, 0, wide() ? -3.4 : 0, wide() ? 0 : 2.4, 0.7],
    admin: () => [0, 0.5, 13.5, 0, 0, 0, 3.4, 0.3],
  };
  const GROUP = { shortlist: 'search', member: 'search', broker: 'brokers', chat: 'msgs', settings: 'profile', payresult: 'pay', apply: 'brokers', notifs: 'msgs' };
  const shot = v => (SHOTS[GROUP[v] || v] || SHOTS.search)();

  const api = window.Scene3D = {
    setView(v) { view = v; },
    pulse() { pulseAt = performance.now() / 1000; },
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('rcg-3d', enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
      document.body.classList.toggle('no3d', !enabled);
      if (enabled) { askGyro(); start(); }
      return enabled;
    },
  };

  function load(src) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error(src)); document.head.appendChild(s); });
  }
  // Self-hosted copy first (put three.min.js in public/vendor/), then the public CDN. Both are pinned to r160, the last release that ships a plain script build.
  const SOURCES = ['/vendor/three.min.js', 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js'];
  async function getThree() {
    if (window.THREE) return window.THREE;
    for (const s of SOURCES) { try { await load(s); if (window.THREE) return window.THREE; } catch (e) { /* try the next one */ } }
    throw new Error('Three.js could not be loaded');
  }

  let renderer, scene, camera, rig, heart, halo, ringA, ringB, ringC, petals = [], dust, light1, light2, clock;
  const cam = { p: null, l: null }, look = { x: 0, y: 0 }, ptr = { x: 0, y: 0, tx: 0, ty: 0 }, tilt = { x: 0, y: 0 };
  let heartPos, heartScale = 1, running = false, raf = 0, W = 0, H = 0;

  function heartShape() {
    const s = new T.Shape();
    s.moveTo(0, -1.25);
    s.bezierCurveTo(-0.35, -0.9, -1.45, -0.35, -1.45, 0.45);
    s.bezierCurveTo(-1.45, 1.1, -0.95, 1.45, -0.5, 1.45);
    s.bezierCurveTo(-0.2, 1.45, 0, 1.25, 0, 0.95);
    s.bezierCurveTo(0, 1.25, 0.2, 1.45, 0.5, 1.45);
    s.bezierCurveTo(0.95, 1.45, 1.45, 1.1, 1.45, 0.45);
    s.bezierCurveTo(1.45, -0.35, 0.35, -0.9, 0, -1.25);
    return s;
  }
  const gold = (rough, emis) => new T.MeshStandardMaterial({ color: 0xe3c070, metalness: 1, roughness: rough, emissive: 0x6b4a0a, emissiveIntensity: emis });

  function build() {
    const small = innerWidth < 700;
    renderer = new T.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    scene = new T.Scene();
    scene.fog = new T.FogExp2(0x12060d, 0.035);
    camera = new T.PerspectiveCamera(45, 1, 0.1, 80);
    cam.p = new T.Vector3(0, 0.2, 9); cam.l = new T.Vector3(0, 0, 0);
    camera.position.copy(cam.p);
    clock = new T.Clock();

    scene.add(new T.HemisphereLight(0xffe0c0, 0x2a0a18, 1.1));
    light1 = new T.PointLight(0xffc766, 90, 40, 2); light1.position.set(4, 3, 6); scene.add(light1);
    light2 = new T.PointLight(0xd23b6e, 70, 40, 2); light2.position.set(-5, -2, 4); scene.add(light2);

    rig = new T.Group(); scene.add(rig);

    // the heart: deep-red enamel with a gold wire skin
    const g = new T.ExtrudeGeometry(heartShape(), { depth: 0.55, bevelEnabled: true, bevelThickness: 0.22, bevelSize: 0.2, bevelSegments: 8, curveSegments: 40 });
    g.center();
    heart = new T.Mesh(g, new T.MeshStandardMaterial({ color: 0x9b1240, metalness: 0.55, roughness: 0.22, emissive: 0x4a0620, emissiveIntensity: 0.9 }));
    halo = new T.Mesh(g, new T.MeshBasicMaterial({ color: 0xe3c070, wireframe: true, transparent: true, opacity: 0.16 }));
    halo.scale.setScalar(1.045);
    heart.add(halo);
    rig.add(heart);

    // two interlocked wedding rings around the heart, and a slow armillary ring
    ringA = new T.Mesh(new T.TorusGeometry(2.35, 0.075, 24, small ? 100 : 180), gold(0.22, 0.5));
    ringB = new T.Mesh(new T.TorusGeometry(2.35, 0.075, 24, small ? 100 : 180), gold(0.3, 0.45));
    ringA.position.x = -0.9; ringB.position.x = 0.9;
    ringA.rotation.y = 1.15; ringB.rotation.y = -1.15;
    ringC = new T.Mesh(new T.TorusGeometry(3.6, 0.018, 12, 220), new T.MeshBasicMaterial({ color: 0xe3c070, transparent: true, opacity: 0.55 }));
    ringC.rotation.x = 1.25;
    heart.add(ringA, ringB, ringC);

    // gold petals drifting around the scene
    const pg = new T.OctahedronGeometry(0.11, 0), pm = gold(0.3, 0.6);
    for (let i = 0; i < (small ? 26 : 46); i++) {
      const m = new T.Mesh(pg, pm), a = Math.random() * 6.283, r = 3 + Math.random() * 7;
      m.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12 - 1);
      m.userData = { s: 0.2 + Math.random() * 0.5, p: Math.random() * 6.283, a: 0.2 + Math.random() * 0.4 };
      m.scale.setScalar(0.6 + Math.random() * 1.4);
      scene.add(m); petals.push(m);
    }
    // fireflies
    const n = small ? 320 : 700, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 4 + Math.random() * 16, a = Math.random() * 6.283, b = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(b) * Math.cos(a); pos[i * 3 + 1] = r * Math.sin(b) * Math.sin(a) * 0.7; pos[i * 3 + 2] = r * Math.cos(b) - 2;
    }
    const dg = new T.BufferGeometry(); dg.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    dust = new T.Points(dg, new T.PointsMaterial({ color: 0xf1d38a, size: 0.05, transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending }));
    scene.add(dust);

    heartPos = new T.Vector3(); resize();
  }

  function resize() {
    if (!renderer) return;
    W = innerWidth; H = innerHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
  }

  function frame() {
    raf = 0;
    if (!running || !enabled || document.hidden) return;
    const t = clock.getElapsedTime();
    const s = shot(view), k = reduce ? 1 : 0.045;
    // camera glides to the viewpoint for this screen, plus pointer, scroll and tilt parallax
    ptr.x += (ptr.tx - ptr.x) * 0.06; ptr.y += (ptr.ty - ptr.y) * 0.06;
    const sc = Math.min(scrollY, 2400) * 0.0016;
    const px = (gyro ? tilt.x : ptr.x) * 0.9, py = (gyro ? tilt.y : ptr.y) * 0.6;
    cam.p.x += (s[0] + px - cam.p.x) * k; cam.p.y += (s[1] - py - sc - cam.p.y) * k; cam.p.z += (s[2] + sc * 2 - cam.p.z) * k;
    look.x += (s[3] - look.x) * k; look.y += (s[4] - look.y) * k;
    camera.position.copy(cam.p); camera.lookAt(look.x, look.y, 0);
    // the heart moves aside for content-heavy screens
    heartPos.x += (s[5] - heartPos.x) * k; heartPos.y += (s[6] - heartPos.y) * k; heartScale += (s[7] - heartScale) * k;
    const since = performance.now() / 1000 - pulseAt, beat = Math.exp(-since * 3.2) * Math.sin(since * 14) * 0.08;
    const idle = 1 + Math.pow(Math.max(0, Math.sin(t * 2.1)), 12) * 0.05; // a quiet heartbeat
    rig.position.set(heartPos.x, heartPos.y + Math.sin(t * 0.8) * 0.12, 0);
    rig.scale.setScalar(heartScale * (idle + (since < 2 ? beat : 0)));
    heart.rotation.y = Math.sin(t * 0.35) * 0.55 + ptr.x * 0.4; heart.rotation.x = Math.sin(t * 0.27) * 0.12 - ptr.y * 0.25;
    ringA.rotation.x = t * 0.32; ringB.rotation.x = -t * 0.28; ringC.rotation.z = t * 0.12; ringC.rotation.y = Math.sin(t * 0.2) * 0.4;
    for (const m of petals) { const d = m.userData; m.position.y += Math.sin(t * d.s + d.p) * 0.004; m.position.x += Math.cos(t * d.s + d.p) * 0.002; m.rotation.x = t * d.a; m.rotation.y = t * d.a * 0.7; }
    dust.rotation.y = t * 0.012; dust.rotation.x = Math.sin(t * 0.05) * 0.05;
    dust.material.opacity = view === 'admin' ? 0.3 : 0.85;
    light1.position.x = 4 + Math.sin(t * 0.5) * 3; light2.position.y = -2 + Math.cos(t * 0.4) * 3;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!ready || running && raf) return; running = true; if (!raf) raf = requestAnimationFrame(frame); }

  /* input */
  addEventListener('pointermove', e => { if (e.pointerType === 'touch' && gyro) return; ptr.tx = e.clientX / innerWidth * 2 - 1; ptr.ty = e.clientY / innerHeight * 2 - 1; }, { passive: true });
  addEventListener('touchmove', e => { if (gyro || !e.touches[0]) return; ptr.tx = e.touches[0].clientX / innerWidth * 2 - 1; ptr.ty = e.touches[0].clientY / innerHeight * 2 - 1; }, { passive: true });
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  let gyroAsked = false;
  function onOrient(e) { if (e.gamma == null) return; gyro = true; tilt.x = Math.max(-1, Math.min(1, e.gamma / 35)); tilt.y = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 35)); }
  function askGyro() { // iPhones ask permission, and only from a tap; Android and desktops need none
    if (gyroAsked || typeof DeviceOrientationEvent === 'undefined') return; gyroAsked = true;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') addEventListener('deviceorientation', onOrient); }).catch(() => {});
      else addEventListener('deviceorientation', onOrient);
    } catch (e) { /* ignore */ }
  }
  api.enableTilt = () => { gyroAsked = false; askGyro(); };

  /* cards lean toward the pointer (mouse and pen only) */
  let hot = null;
  document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || reduce) return;
    const c = e.target.closest && e.target.closest('main .card, main .plan');
    if (hot && hot !== c) { hot.style.setProperty('--rx', '0deg'); hot.style.setProperty('--ry', '0deg'); }
    hot = c;
    if (!c || c.closest('form') || c.querySelector('form')) return;
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    c.style.setProperty('--ry', (x * 9).toFixed(2) + 'deg'); c.style.setProperty('--rx', (-y * 9).toFixed(2) + 'deg');
    c.style.setProperty('--gx', (x * 100 + 50).toFixed(0) + '%'); c.style.setProperty('--gy', (y * 100 + 50).toFixed(0) + '%');
  }, { passive: true });

  if (!canvas) return;
  document.body.classList.toggle('no3d', !enabled);
  getThree().then(three => {
    T = three;
    try {
      build();
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; document.body.classList.add('no3d'); });
      ready = true; document.body.classList.add('has3d');
      if (enabled) start();
    } catch (e) { document.body.classList.add('no3d'); console.warn('3D stage unavailable:', e.message); }
  }).catch(e => { document.body.classList.add('no3d'); console.warn('3D stage unavailable:', e.message); });
})();
