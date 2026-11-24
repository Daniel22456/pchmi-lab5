/* ЛР7 · логика полигона (СДР). Генерирует контент и обрабатывает click / hover / drag / swipe. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const rub = n => n.toLocaleString('ru-RU');
  const subjects = ['Поставка компьютерного оборудования', 'Ремонт кровли учебного корпуса', 'Поставка канцелярских товаров',
    'Оказание услуг по уборке помещений', 'Поставка медицинских расходных материалов', 'Техническое обслуживание лифтов',
    'Поставка лабораторной мебели', 'Услуги связи и доступа в интернет', 'Поставка горюче-смазочных материалов',
    'Разработка проектной документации'];
  const methods = ['Электронный аукцион', 'Открытый конкурс', 'Запрос котировок', 'Закупка у ед. поставщика'];
  // детерминированный ГПСЧ, чтобы контент был одинаковым при каждом прогоне
  let seed = 22456; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const notice = i => '0301300' + String(1000000 + i * 7919).slice(-7) + '26' + String(100 + i).slice(-3);
  const date = i => { const d = new Date(2026, 10, 25 + (i % 40)); return d.toLocaleDateString('ru-RU'); };

  const gestures = []; // журнал распознанных жестов для оценки точности
  window.LabApp = { gestures };

  /* 1. карточки закупок: click (раскрыть, в избранное), hover (CSS) */
  const cards = $('#cards');
  cards.innerHTML = Array.from({ length: 6 }, (_, i) => `
    <article class="card" style="animation-delay:${i * 60}ms" data-i="${i}">
      <span class="badge ${i % 3 === 0 ? 'badge-live' : ''}">${i % 3 === 0 ? '<span class="dot"></span>Приём заявок' : 'Рассмотрение'}</span>
      <div class="card-num">№ ${notice(i)}</div>
      <div class="card-title">${subjects[i]}</div>
      <div class="card-sum">${rub(Math.round(150000 + rnd() * 4800000))} ₽</div>
      <div class="card-more">${methods[i % 4]}. Окончание подачи заявок: ${date(i)}. Заявок подано: ${1 + (i * 3) % 7}.</div>
      <div class="btns"><button class="btn btn-sm btn-ghost card-toggle">Подробнее</button><button class="btn btn-sm btn-ghost card-fav">☆ В избранное</button></div>
    </article>`).join('');
  cards.addEventListener('click', e => {
    const card = e.target.closest('.card'); if (!card) return;
    if (e.target.closest('.card-toggle')) {
      const open = card.classList.toggle('card-open');
      e.target.textContent = open ? 'Свернуть' : 'Подробнее';
    } else if (e.target.closest('.card-fav')) {
      const b = e.target.closest('.card-fav'); const on = b.classList.toggle('card-fav-on');
      b.textContent = on ? '★ В избранном' : '☆ В избранное';
    }
  });

  /* 2. доска рассмотрения: drag на Pointer Events (мышь + touch) */
  const board = $('#board');
  const firms = ['ООО «Техносервис»', 'АО «СтройИнвест»', 'ИП Галиев Р. Р.', 'ООО «Офис-Комплект»', 'ООО «МедСнаб»', 'ООО «Лифт-Сервис УФА»', 'АО «Связьинформ»', 'ООО «НефтеТрейд»'];
  const colNew = board.querySelector('[data-col="new"]');
  firms.forEach((f, i) => { const c = document.createElement('div'); c.className = 'chip'; c.dataset.id = 'z' + i; c.textContent = `Заявка ${i + 1}: ${f}`; colNew.appendChild(c); });
  const recount = () => board.querySelectorAll('.col').forEach(col => { col.querySelector('[data-count]').textContent = col.querySelectorAll('.chip').length; });
  recount();
  let drag = null;
  board.addEventListener('pointerdown', e => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    try { chip.setPointerCapture(e.pointerId); } catch (err) { /* синтетический указатель */ }
    drag = { chip, x: e.clientX, y: e.clientY, id: e.pointerId, from: chip.parentElement.dataset.col, over: null };
    chip.classList.add('chip-drag');
  });
  board.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.chip.style.transform = `translate(${e.clientX - drag.x}px,${e.clientY - drag.y}px)`;
    drag.chip.style.pointerEvents = 'none';
    const col = document.elementFromPoint(e.clientX, e.clientY)?.closest('.col');
    drag.chip.style.pointerEvents = '';
    if (drag.over !== col) { drag.over?.classList.remove('col-over'); col?.classList.add('col-over'); drag.over = col; }
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const { chip, over, from } = drag;
    chip.classList.remove('chip-drag'); chip.style.transform = '';
    over?.classList.remove('col-over');
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (over && over.dataset.col !== from) { over.appendChild(chip); recount(); }
    gestures.push({ type: 'drag', id: chip.dataset.id, to: over ? over.dataset.col : null, from, dist: Math.round(dist), pointer: e.pointerType, t: performance.now() });
    drag = null;
  };
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);

  /* 3. свайп-карусель лотов */
  const track = $('#track'), dots = $('#dots'), swipe = $('#swipe');
  const lots = [['Лот 1', 'Ноутбуки — 40 шт.'], ['Лот 2', 'Мониторы — 60 шт.'], ['Лот 3', 'МФУ — 12 шт.'], ['Лот 4', 'Серверное оборудование']];
  track.innerHTML = lots.map(([a, b]) => `<div class="slide"><b>${a}</b>${b}</div>`).join('');
  dots.innerHTML = lots.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('');
  let slide = 0, sw = null;
  const go = n => { slide = Math.max(0, Math.min(lots.length - 1, n)); track.style.transform = `translateX(${-slide * 100}%)`; [...dots.children].forEach((d, i) => d.classList.toggle('on', i === slide)); };
  swipe.addEventListener('pointerdown', e => { sw = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; try { swipe.setPointerCapture(e.pointerId); } catch (err) { /* синтетический указатель */ } });
  const endSwipe = e => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y, dt = performance.now() - sw.t;
    let dir = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) dir = dx < 0 ? 'left' : 'right';
    if (dir) go(slide + (dir === 'left' ? 1 : -1));
    gestures.push({ type: 'swipe', dir, dx: Math.round(dx), dy: Math.round(dy), dt: Math.round(dt), pointer: e.pointerType, slide, t: performance.now() });
    sw = null;
  };
  swipe.addEventListener('pointerup', endSwipe);
  swipe.addEventListener('pointercancel', endSwipe);

  /* 4. реестр извещений: 400 строк в прокручиваемой области */
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(`<tr><td>${notice(i + 10)}</td><td>${subjects[i % subjects.length]}</td><td>${methods[i % 4]}</td><td class="num">${rub(Math.round(50000 + rnd() * 9000000))}</td><td>${date(i)}</td></tr>`);
  $('#regBody').innerHTML = rows.join('');

  /* 5. искусственная длинная задача ~300 мс (синхронный цикл на главном потоке) */
  $('#btnLong').addEventListener('click', () => {
    const t0 = performance.now(); let x = 0;
    while (performance.now() - t0 < 300) x += Math.sqrt(x + 1);
    $('#ltOut').textContent = `Отчёт сформирован: главный поток был занят ${Math.round(performance.now() - t0)} мс`;
  });

  /* панель метрик */
  const panel = $('#mpanel');
  const toggle = on => panel.classList.toggle('mpanel-on', on);
  $('#btnPanel').addEventListener('click', () => toggle(true));
  $('#btnFab').addEventListener('click', () => toggle(true));
  $('#btnClose').addEventListener('click', () => toggle(false));
  $('#btnRun').addEventListener('click', async () => { $('#mout').textContent = 'Идёт прогон…'; const r = await window.LabMetrics.runAll(); window.LabMetrics.render($('#mout'), r); });
  $('#btnJson').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(window.LabMetrics.snapshot(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lab7_metrics.json'; a.click();
  });
})();
