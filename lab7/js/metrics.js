/* ЛР7 · модуль измерения метрик UI (Саяхов Д. Р., ИВТ-ПО-302Б, СДР).
   Подключается в <head> синхронно, чтобы наблюдатели стартовали до первой отрисовки.
   Группа 1: FP, FCP, LCP, CLS, Long Tasks, INP (PerformanceObserver, buffered:true), TTI/TBT (эвристика), FPS и scroll jank (rAF).
   Группа 2: задержка ввода «событие → первый кадр» для click/hover/pointer, аудит длительностей анимаций,
             touch-action + viewport, точность распознавания жестов.
   Группа 3: DOM size/depth, CSS specificity max, неиспользуемые селекторы, memory footprint (каждые 5 с). */
(function () {
  'use strict';
  const now = () => performance.now();
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1); return s[Math.max(0, i)]; };
  const median = a => pct(a, 50);
  const r1 = x => x == null ? null : Math.round(x * 10) / 10;

  const M = {
    paint: {}, lcp: [], longtasks: [], events: [], firstInput: null,
    cls: { value: 0, maxSession: 0, shifts: [] }, memory: [], inputs: [], frameTests: {}, gestureTest: null,
    supported: PerformanceObserver.supportedEntryTypes || []
  };

  /* ---------- Группа 1: PerformanceObserver ---------- */
  function observe(type, cb, extra) {
    if (!M.supported.includes(type)) return;
    try { new PerformanceObserver(list => list.getEntries().forEach(cb)).observe(Object.assign({ type, buffered: true }, extra)); } catch (e) { /* тип не поддерживается */ }
  }
  observe('paint', e => { M.paint[e.name] = e.startTime; });
  observe('largest-contentful-paint', e => {
    const el = e.element; M.lcp.push({ t: e.startTime, size: e.size, el: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : '') : null });
  });
  let sess = { v: 0, first: 0, last: 0 };
  observe('layout-shift', e => {
    if (e.hadRecentInput) return;
    M.cls.value += e.value; M.cls.shifts.push({ t: e.startTime, v: e.value });
    // окна сессий (≤5 с, разрыв ≤1 с) — так считает CLS методика Core Web Vitals
    if (sess.v && e.startTime - sess.last < 1000 && e.startTime - sess.first < 5000) { sess.v += e.value; sess.last = e.startTime; }
    else sess = { v: e.value, first: e.startTime, last: e.startTime };
    M.cls.maxSession = Math.max(M.cls.maxSession, sess.v);
  });
  observe('longtask', e => { M.longtasks.push({ start: e.startTime, duration: e.duration, end: e.startTime + e.duration }); });
  observe('event', e => { if (e.interactionId) M.events.push({ id: e.interactionId, name: e.name, start: e.startTime, duration: e.duration, inputDelay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart }); }, { durationThreshold: 16 });
  observe('first-input', e => { M.firstInput = { name: e.name, delay: e.processingStart - e.startTime }; });

  /* TTI: от FCP ищем первое «тихое окно» 5 с без длинных задач; TTI = конец последней длинной задачи перед окном. */
  function computeTTI() {
    const fcp = M.paint['first-contentful-paint'];
    if (fcp == null) return { tti: null, tbt: null, confirmed: false };
    const lts = M.longtasks.slice().sort((a, b) => a.start - b.start);
    let tti = fcp;
    for (const lt of lts) {
      if (lt.end <= tti) continue;
      if (lt.start - tti >= 5000) break;       // нашли окно тишины ≥ 5 с
      tti = Math.max(tti, lt.end);
    }
    const confirmed = now() - tti >= 5000;
    // TBT: Σ(duration − 50) по длинным задачам между FCP и TTI (часть задачи до FCP не учитывается)
    let tbt = 0;
    for (const lt of lts) {
      if (lt.end <= fcp || lt.start >= tti) continue;
      const s = Math.max(lt.start, fcp), d = lt.end - s;
      if (d > 50) tbt += d - 50;
    }
    return { tti, tbt, confirmed, loadLongTasks: lts.filter(l => l.start < tti + 1) };
  }

  /* INP: группируем записи event по interactionId (берём максимальную длительность внутри взаимодействия). */
  function computeINP() {
    const by = new Map();
    for (const e of M.events) { const c = by.get(e.id); if (!c || e.duration > c.duration) by.set(e.id, e); }
    const arr = [...by.values()];
    const d = arr.map(e => e.duration);
    return { count: arr.length, p75: pct(d, 75), p98: pct(d, 98), max: d.length ? Math.max(...d) : null, worst: arr.sort((a, b) => b.duration - a.duration).slice(0, 3) };
  }

  /* FPS и scroll jank: счётчик кадров на requestAnimationFrame. step(progress) двигает прокрутку/анимацию. */
  async function frameMeter(durationMs, step) {
    const deltas = []; let prev = null; const t0 = now();
    await new Promise(resolve => {
      function tick(ts) {
        if (prev != null) deltas.push(ts - prev);
        prev = ts;
        const p = Math.min(1, (now() - t0) / durationMs);
        if (step) step(p);
        if (p < 1) requestAnimationFrame(tick); else resolve();
      }
      requestAnimationFrame(tick);
    });
    const total = deltas.reduce((a, b) => a + b, 0);
    const budget = 1000 / 60;                     // 16,7 мс
    const jank = deltas.filter(d => d > budget + 0.5).length;   // +0,5 мс — допуск на дрожание таймстемпов
    return { frames: deltas.length, fps: deltas.length / (total / 1000), minFps: 1000 / Math.max(...deltas), jankFrames: jank, jankRate: jank / deltas.length, p95Frame: pct(deltas, 95), maxFrame: Math.max(...deltas) };
  }
  async function scrollTest(kind = 'area', durationMs = 3000) {
    const el = kind === 'area' ? document.getElementById('scroll') : document.scrollingElement;
    el.scrollTop = 0; await raf(); await raf();
    const max = el.scrollHeight - el.clientHeight;
    const r = await frameMeter(durationMs, p => { el.scrollTop = Math.round(max * p); });
    M.frameTests['scroll-' + kind] = r; return r;
  }
  async function animationTest() {
    const cards = [...document.querySelectorAll('.card')];
    cards.forEach(c => { c.style.animation = 'none'; }); void document.body.offsetHeight;
    cards.forEach(c => { c.style.animation = ''; });
    const r = await frameMeter(1200, p => { if (p > 0.4) cards.forEach(c => c.classList.add('card-open')); });
    cards.forEach(c => c.classList.remove('card-open'));
    M.frameTests.animation = r; return r;
  }

  /* ---------- Группа 2: задержка «событие → первый кадр» ---------- */
  // event.timeStamp у доверенных событий Chromium — время аппаратного события; rAF после обработчика = начало кадра с реакцией.
  function trackInput(type, kind, filter) {
    document.addEventListener(type, ev => {
      if (filter && !filter(ev)) return;
      const t = ev.timeStamp, target = ev.target.closest ? (ev.target.closest('button,.card,.chip,.tip,.swipe,tr') || ev.target) : ev.target;
      const label = target.id || target.className || target.tagName;
      requestAnimationFrame(ts => {
        const toFrame = performance.now() - t;
        // второй этап: момент после отрисовки кадра (rAF + задача) — время до видимого изменения состояния
        setTimeout(() => M.inputs.push({ kind, label: String(label).slice(0, 40), toFrame, toPaint: performance.now() - t, trusted: ev.isTrusted }), 0);
      });
    }, { capture: true, passive: true });
  }
  trackInput('pointerdown', 'pointer');
  trackInput('click', 'click');
  trackInput('pointerover', 'hover', ev => ev.pointerType === 'mouse' && ev.target.closest && ev.target.closest('.card,.btn,.tip,.reg tr'));
  trackInput('keydown', 'key');
  function inputStats(kind, filter) {
    const a = M.inputs.filter(i => i.kind === kind && (!filter || filter(i)));
    const f = a.map(i => i.toFrame), p = a.map(i => i.toPaint);
    return { n: a.length, median: median(f), p75: pct(f, 75), max: f.length ? Math.max(...f) : null, paintMedian: median(p), paintP75: pct(p, 75), paintMax: p.length ? Math.max(...p) : null };
  }

  /* Аудит длительностей анимаций против токенов 150/250/400 мс */
  const TOKENS = [150, 250, 400];
  const toMs = s => s.trim().endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
  function auditAnimations() {
    const seen = new Map();
    const add = (sig, prop, ms) => { if (!ms) return; const k = sig + '|' + prop + '|' + ms; if (!seen.has(k)) seen.set(k, { sig, prop, ms, ok: TOKENS.includes(Math.round(ms)) }); };
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const sig = el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].filter(c => !/-(open|on|over|drag)$/.test(c)).join('.') : '');
      cs.transitionDuration.split(',').forEach((d, i) => add(sig, 'transition:' + cs.transitionProperty.split(',')[i]?.trim(), toMs(d)));
      if (cs.animationName !== 'none') cs.animationDuration.split(',').forEach((d, i) => add(sig, 'animation:' + cs.animationName.split(',')[i]?.trim(), toMs(d)));
    }
    // объединяем одинаковые правила (один селектор → одна запись)
    const list = [...seen.values()];
    const uniq = new Map(); list.forEach(x => { const k = x.prop.split(':')[0] + ':' + x.prop.split(':')[1] + '|' + x.ms + '|' + x.sig.split('.')[1]; if (!uniq.has(k)) uniq.set(k, x); });
    const u = [...uniq.values()];
    const ok = u.filter(x => x.ok).length;
    return { total: u.length, ok, rate: u.length ? ok / u.length : 1, violations: u.filter(x => !x.ok), items: u };
  }

  /* Защита от double-tap zoom: viewport + эффективный touch-action интерактивных элементов */
  function effectiveTouchAction(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const ta = getComputedStyle(n).touchAction; if (ta !== 'auto') return ta; }
    return 'auto';
  }
  function auditTouch() {
    const vp = document.querySelector('meta[name=viewport]')?.content || '';
    const inter = [...document.querySelectorAll('button,a,input,select,textarea,.chip,.swipe,.card,[tabindex]')];
    const prot = inter.filter(el => effectiveTouchAction(el) !== 'auto');
    return { viewport: vp, widthDevice: /width\s*=\s*device-width/.test(vp), userScalableBlocked: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(vp), rootTouchAction: getComputedStyle(document.documentElement).touchAction, interactive: inter.length, protected: prot.length, rate: inter.length ? prot.length / inter.length : 1 };
  }

  /* Точность распознавания жестов: сравнение ожидаемых и распознанных жестов приложения */
  function gestureAccuracy(expected) {
    const got = (window.LabApp?.gestures || []).slice(-expected.length);
    let ok = 0;
    const rows = expected.map((exp, i) => { const g = got[i]; const hit = !!g && g.type === exp.type && (exp.type === 'swipe' ? g.dir === exp.dir : g.to === exp.to); if (hit) ok++; return { exp, got: g || null, hit }; });
    M.gestureTest = { total: expected.length, ok, rate: expected.length ? ok / expected.length : null, rows };
    return M.gestureTest;
  }
  // синтетические жесты PointerEvent (pointerType: touch) — для прогона прямо в браузере без эмулятора
  async function syntheticGestures() {
    const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    const expected = [];
    const sw = document.getElementById('swipe'); sw.scrollIntoView({ block: 'center' }); await raf();
    const r = sw.getBoundingClientRect(), cy = r.top + r.height / 2;
    const plan = ['left', 'left', 'right', 'left', 'right', 'right'];
    for (const dir of plan) {
      const x0 = dir === 'left' ? r.right - 30 : r.left + 30, x1 = dir === 'left' ? r.left + 30 : r.right - 30;
      fire(sw, 'pointerdown', x0, cy); for (let k = 1; k <= 6; k++) { fire(sw, 'pointermove', x0 + (x1 - x0) * k / 6, cy + k); await raf(); }
      fire(sw, 'pointerup', x1, cy + 6); expected.push({ type: 'swipe', dir }); await sleep(300);
    }
    const board = document.getElementById('board'); board.scrollIntoView({ block: 'center' }); await raf();
    const cols = ['ok', 'no', 'ok', 'ok'];
    for (const to of cols) {
      const chip = board.querySelector('[data-col="new"] .chip'); if (!chip) break;
      const a = chip.getBoundingClientRect(), b = board.querySelector(`[data-col="${to}"]`).getBoundingClientRect();
      const x0 = a.left + 20, y0 = a.top + 10, x1 = b.left + b.width / 2, y1 = b.top + b.height - 30;
      fire(chip, 'pointerdown', x0, y0); for (let k = 1; k <= 8; k++) { fire(chip, 'pointermove', x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8); await raf(); }
      fire(chip, 'pointerup', x1, y1); expected.push({ type: 'drag', to }); await sleep(200);
    }
    return gestureAccuracy(expected);
  }

  /* ---------- Группа 3: DOM, CSS, память ---------- */
  function auditDOM() {
    const all = document.getElementsByTagName('*');
    let maxDepth = 0, deepest = null;
    for (const el of all) { let d = 0; for (let n = el; n; n = n.parentElement) d++; if (d > maxDepth) { maxDepth = d; deepest = el; } }
    let maxChildren = 0; for (const el of all) maxChildren = Math.max(maxChildren, el.children.length);
    return { nodes: all.length, depth: maxDepth, deepest: deepest && deepest.tagName.toLowerCase() + (deepest.className ? '.' + deepest.className : ''), maxChildren };
  }
  // специфичность (a-b-c): a — id, b — классы/атрибуты/псевдоклассы, c — типы/псевдоэлементы
  function specificity(sel) {
    let a = 0, b = 0, c = 0, s = sel.replace(/::?(before|after|first-line|first-letter)\b/g, () => { c++; return ' '; });
    s = s.replace(/:(not|is|has)\(([^()]*)\)/g, (m, f, inner) => { const sp = inner.split(',').map(x => specificity(x.trim())).sort(cmp).pop() || [0, 0, 0]; a += sp[0]; b += sp[1]; c += sp[2]; return ' '; });
    s = s.replace(/:where\([^()]*\)/g, ' ');
    s = s.replace(/::[\w-]+/g, () => { c++; return ' '; });
    s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
    s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
    s = s.replace(/\[[^\]]+\]/g, () => { b++; return ' '; });
    s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ' '; });
    s = s.replace(/[>+~*]/g, ' ');
    (s.match(/[a-zA-Z][\w-]*/g) || []).forEach(() => c++);
    return [a, b, c];
  }
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  function styleRules() {
    const out = [];
    const walk = (rules, sheet) => { for (const r of rules) { if (r.selectorText) out.push({ sel: r.selectorText, len: r.cssText.length, sheet }); else if (r.cssRules) walk(r.cssRules, sheet); } };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules, sh.href ? sh.href.split('/').pop() : 'inline'); } catch (e) { /* чужой origin */ } }
    return out;
  }
  function auditCSS() {
    const rules = styleRules(); const sels = [];
    rules.forEach(r => r.sel.split(/,(?![^(]*\))/).forEach(s => sels.push({ s: s.trim(), sp: specificity(s.trim()) })));
    sels.sort((x, y) => cmp(y.sp, x.sp));
    const over = sels.filter(x => cmp(x.sp, [0, 1, 0]) > 0);
    // неиспользуемые селекторы: правило не совпадает ни с одним элементом (без учёта состояний :hover/:focus)
    let unusedBytes = 0, totalBytes = 0, unusedRules = 0;
    rules.forEach(r => {
      totalBytes += r.len;
      const used = r.sel.split(/,(?![^(]*\))/).some(s => { const q = s.replace(/::?(hover|focus|focus-visible|active|visited|before|after)\b/g, '').trim() || '*'; try { return !!document.querySelector(q); } catch (e) { return true; } });
      if (!used) { unusedBytes += r.len; unusedRules++; }
    });
    return { selectors: sels.length, max: sels[0], top: sels.slice(0, 6).map(x => x.s + ' → ' + x.sp.join('-')), overClassLevel: over.length, overRate: over.length / sels.length, rules: rules.length, unusedRules, unusedByteRate: unusedBytes / totalBytes };
  }
  function sampleMemory() {
    if (!performance.memory) return;
    M.memory.push({ t: Math.round(now()), used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize });
  }
  sampleMemory(); setInterval(sampleMemory, 5000);
  function memoryStats() {
    const m = M.memory; if (m.length < 2) return { supported: !!performance.memory, samples: m.length };
    const first = m[0].used, last = m[m.length - 1].used, mx = Math.max(...m.map(x => x.used));
    // наклон линейной регрессии used(t), байт/мин
    const n = m.length, xs = m.map(x => x.t / 60000), ys = m.map(x => x.used), mxs = xs.reduce((a, b) => a + b) / n, mys = ys.reduce((a, b) => a + b) / n;
    const slope = xs.reduce((s, x, i) => s + (x - mxs) * (ys[i] - mys), 0) / xs.reduce((s, x) => s + (x - mxs) ** 2, 0);
    return { supported: true, samples: n, firstMB: first / 1048576, lastMB: last / 1048576, maxMB: mx / 1048576, growth: (last - first) / first, slopeKBperMin: slope / 1024 };
  }

  /* ---------- сводка и статусы ---------- */
  const ST = (v, good, needs, higherBetter) => v == null ? '—' : higherBetter ? (v >= good ? 'Good' : v >= needs ? 'Needs work' : 'Poor') : (v <= good ? 'Good' : v <= needs ? 'Needs work' : 'Poor');
  function snapshot() {
    const t = computeTTI(), inp = computeINP(), lcp = M.lcp[M.lcp.length - 1] || {};
    const sa = M.frameTests['scroll-area'], sp = M.frameTests['scroll-page'], an = M.frameTests.animation;
    const click = inputStats('click'), clickNoLong = inputStats('click', i => i.label !== 'btnLong'), hover = inputStats('hover', i => i.label !== 'btnLong'), ptr = inputStats('pointer', i => i.label !== 'btnLong');
    const anim = auditAnimations(), touch = auditTouch(), dom = auditDOM(), css = auditCSS(), mem = memoryStats();
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').map(r => ({ name: r.name.split('/').slice(-2).join('/'), type: r.initiatorType, transfer: r.transferSize, body: r.decodedBodySize }));
    const fpsMin = [sa, sp, an].filter(Boolean).map(x => x.fps);
    return {
      meta: { url: location.href, ua: navigator.userAgent, viewport: innerWidth + '×' + innerHeight, dpr: devicePixelRatio, at: new Date().toISOString(), supported: M.supported },
      group1: {
        FP: { v: r1(M.paint['first-paint']), unit: 'мс' },
        FCP: { v: r1(M.paint['first-contentful-paint']), unit: 'мс', status: ST(M.paint['first-contentful-paint'], 1800, 3000) },
        LCP: { v: r1(lcp.t), unit: 'мс', el: lcp.el, status: ST(lcp.t, 2500, 4000) },
        TTI: { v: r1(t.tti), unit: 'мс', confirmed: t.confirmed, status: ST(t.tti, 3900, 7300) },
        TBT: { v: r1(t.tbt), unit: 'мс', status: ST(t.tbt, 200, 600) },
        CLS: { v: Math.round(M.cls.maxSession * 1000) / 1000, sum: Math.round(M.cls.value * 1000) / 1000, shifts: M.cls.shifts.length, status: ST(M.cls.maxSession, 0.1, 0.25) },
        INP: { v: r1(inp.p75), max: r1(inp.max), p98: r1(inp.p98), interactions: inp.count, worst: inp.worst, unit: 'мс', status: ST(inp.p75, 200, 500) },
        FPS: { scrollArea: sa && r1(sa.fps), scrollPage: sp && r1(sp.fps), animation: an && r1(an.fps), min: fpsMin.length ? r1(Math.min(...fpsMin)) : null, status: ST(fpsMin.length ? Math.min(...fpsMin) : null, 55, 30, true) },
        LongTasks: { loadCount: (t.loadLongTasks || []).length, loadTotal: r1((t.loadLongTasks || []).reduce((s, l) => s + l.duration, 0)), totalCount: M.longtasks.length, totalMs: r1(M.longtasks.reduce((s, l) => s + l.duration, 0)), list: M.longtasks.map(l => ({ start: r1(l.start), duration: r1(l.duration) })) },
        ScrollJank: { area: sa && r1(sa.jankRate * 100), page: sp && r1(sp.jankRate * 100), unit: '%', frames: sa && sa.frames, p95Frame: sa && r1(sa.p95Frame), maxFrame: sa && r1(sa.maxFrame), status: ST(sa ? Math.max(sa.jankRate, sp ? sp.jankRate : 0) * 100 : null, 1, 5) }
      },
      group2: {
        InputLatency: Object.assign(ptr, { status: ST(ptr.p75, 100, 200) }),
        ClickResponse: Object.assign(clickNoLong, { withLongTask: click.max, status: ST(clickNoLong.paintP75, 100, 200) }),
        HoverResponse: Object.assign(hover, { status: ST(hover.p75, 50, 100) }),
        AnimationConsistency: { rate: Math.round(anim.rate * 1000) / 10, ok: anim.ok, total: anim.total, violations: anim.violations, status: ST(anim.rate * 100, 100, 80, true) },
        GestureAccuracy: M.gestureTest ? { rate: Math.round(M.gestureTest.rate * 1000) / 10, ok: M.gestureTest.ok, total: M.gestureTest.total, status: ST(M.gestureTest.rate * 100, 98, 90, true) } : { rate: null },
        DoubleTapZoom: Object.assign(touch, { status: touch.widthDevice && touch.rate === 1 ? 'Good' : touch.widthDevice || touch.rate > 0.5 ? 'Needs work' : 'Poor' })
      },
      group3: {
        DOM: Object.assign(dom, { statusSize: ST(dom.nodes, 1500, 3000), statusDepth: ST(dom.depth, 32, 48) }),
        CSS: Object.assign(css, { status: !css.max ? '—' : css.max.sp[0] > 0 ? 'Poor' : cmp(css.max.sp, [0, 1, 0]) <= 0 ? 'Good' : 'Needs work', unusedStatus: ST(css.unusedByteRate * 100, 20, 40) }),
        Memory: Object.assign(mem, { status: mem.growth == null ? '—' : ST(mem.growth * 100, 10, 30) }),
        Resources: { navigation: nav && { ttfb: r1(nav.responseStart), domContentLoaded: r1(nav.domContentLoadedEventEnd), load: r1(nav.loadEventEnd), transfer: nav.transferSize, body: nav.decodedBodySize }, list: res }
      },
      raw: { memory: M.memory, inputs: M.inputs, frameTests: M.frameTests, lcp: M.lcp, gestures: M.gestureTest }
    };
  }

  async function runAll() {
    const fcp = M.paint['first-contentful-paint'] || 0;
    const wait = fcp + 5200 - now(); if (wait > 0) await sleep(wait);     // окно тишины для TTI
    await scrollTest('area'); await scrollTest('page');
    window.scrollTo(0, 0); await raf();
    await animationTest();
    // клики по кнопкам карточек (синтетические события — для оценки обработчиков)
    for (const b of [...document.querySelectorAll('.card-toggle,.card-fav')].slice(0, 6)) { b.click(); await raf(); await sleep(60); }
    await syntheticGestures();
    document.getElementById('btnLong').click(); await sleep(400);
    window.scrollTo(0, 0);
    return snapshot();
  }

  function render(box, s) {
    const g = (name, v, st) => `<tr><td>${name}</td><td>${v ?? '—'}</td><td class="${st === 'Good' ? 'st-good' : st === 'Poor' ? 'st-poor' : 'st-needs'}">${st || ''}</td></tr>`;
    const a = s.group1, b = s.group2, c = s.group3;
    box.innerHTML = `<table class="mtab">
      <tr><td colspan="3" class="mgroup">Группа 1. Рендеринг и отклик</td></tr>
      ${g('FP', a.FP.v + ' мс')}${g('FCP', a.FCP.v + ' мс', a.FCP.status)}${g('LCP', a.LCP.v + ' мс', a.LCP.status)}
      ${g('TTI', a.TTI.v + ' мс', a.TTI.status)}${g('TBT', a.TBT.v + ' мс', a.TBT.status)}${g('CLS', a.CLS.v, a.CLS.status)}
      ${g('INP (p75)', a.INP.v + ' мс', a.INP.status)}${g('FPS (мин.)', a.FPS.min, a.FPS.status)}
      ${g('Long tasks', a.LongTasks.totalCount + ' / ' + a.LongTasks.totalMs + ' мс')}${g('Scroll jank', a.ScrollJank.area + ' %', a.ScrollJank.status)}
      <tr><td colspan="3" class="mgroup">Группа 2. Ввод</td></tr>
      ${g('Input latency p75', r1(b.InputLatency.p75) + ' мс', b.InputLatency.status)}${g('Click response p75', r1(b.ClickResponse.paintP75) + ' мс', b.ClickResponse.status)}
      ${g('Hover p75', r1(b.HoverResponse.p75) + ' мс', b.HoverResponse.status)}${g('Анимации по токенам', b.AnimationConsistency.rate + ' %', b.AnimationConsistency.status)}
      ${g('Жесты', b.GestureAccuracy.rate + ' %', b.GestureAccuracy.status)}${g('Double-tap zoom', b.DoubleTapZoom.rootTouchAction, b.DoubleTapZoom.status)}
      <tr><td colspan="3" class="mgroup">Группа 3. Ресурсы</td></tr>
      ${g('DOM size', c.DOM.nodes, c.DOM.statusSize)}${g('DOM depth', c.DOM.depth, c.DOM.statusDepth)}
      ${g('CSS specificity max', c.CSS.max.sp.join('-'), c.CSS.status)}${g('Неисп. CSS (селекторы)', r1(c.CSS.unusedByteRate * 100) + ' %', c.CSS.unusedStatus)}
      ${g('Память JS', c.Memory.lastMB ? r1(c.Memory.lastMB) + ' МБ' : 'нет API', c.Memory.status)}
    </table><div class="muted">Hover и реальные жесты точнее мерить живым вводом (наведите курсор, свайпните пальцем) и снова нажать «Прогнать тесты».</div>`;
  }

  window.LabMetrics = { M, computeTTI, computeINP, frameMeter, scrollTest, animationTest, auditAnimations, auditTouch, auditDOM, auditCSS, specificity, gestureAccuracy, syntheticGestures, memoryStats, sampleMemory, inputStats, snapshot, runAll, render };
})();
