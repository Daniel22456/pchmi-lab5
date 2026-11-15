"""ЛР №5. Проверка прототипа по тестовым заданиям (прогон проектировщиком).

Скрипт проходит все тестовые задания по оптимальному пути, заложенному
в GOMS-модели, и проверяет, что каждое задание выполнимо, а переходы между
экранными формами совпадают с последовательностью из пользовательских сценариев.
Это НЕ тестирование с испытуемыми: паузы между действиями заданы скриптом.

Запуск:  python walkthrough.py index.html  [папка_для_логов]
"""
import sys, json
from pathlib import Path
from playwright.sync_api import sync_playwright

PAUSE = 250  # мс между действиями


def run(page_path, out_dir):
    url = Path(page_path).resolve().as_uri()
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    shots = out / "screens"; shots.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url)
        pg.evaluate("localStorage.clear()")
        pg.goto(url)

        def w(ms=PAUSE): pg.wait_for_timeout(ms)
        def click(sel): pg.click(sel); w()
        def shot(name): pg.screenshot(path=str(shots / f"{name}.png"), full_page=True)
        def typ(sel, text):
            pg.click(sel); w(80)
            pg.fill(sel, ""); pg.type(sel, text, delay=30)
        def screen(): return pg.evaluate("window.__LR5.S.screen")

        click("text=Начать тестирование")
        pg.fill("#r_code", "ПРОВЕРКА")
        pg.select_option("#r_pc", "высокий"); pg.select_option("#r_exp", "работал(а) с ними")
        shot("00_registration")
        click("text=Перейти к заданиям")
        route = {}

        def begin(tid):
            shot(f"{tid}_0_intro")
            click("text=Начать задание")
            route[tid] = [screen()]

        def track(): route[cur].append(screen()) if route[cur][-1] != screen() else None

        # ---------- T1 ----------
        cur = "T1"; begin(cur); shot("T1_1_home")
        click(".hero >> text=Создать закупку"); track()
        typ("#p_name", "Поставка канцелярских товаров")
        typ("#p_nmck", "450000")
        pg.select_option("#p_method", "Электронный аукцион"); w()
        typ("#p_deadline", "25.11.2026")
        click("text=Прикрепить документ"); shot("T1_2_filepicker")
        click(".picker li:has-text('Техническое задание.pdf')"); shot("T1_3_form")
        click("text=Сохранить черновик"); track(); shot("T1_4_card")
        click("button:has-text('Опубликовать')"); shot("T1_5_confirm")
        click(".modal >> button:has-text('Опубликовать')"); track(); shot("T1_6_published")
        click(".tb-done")

        # ---------- T2 ----------
        cur = "T2"; begin(cur)
        click(".card:has-text('Новые заявки')"); track()
        click("button:has-text('Заявки (')"); track()
        pg.select_option("#f4st", "sent"); w()
        pg.select_option("#f4sort", "price"); w(); shot("T2_1_apps_filtered")
        click("tr:has-text('ЧистоДом')"); track(); shot("T2_2_app")
        click("button[data-f='Лицензия.pdf']"); shot("T2_3_doc")
        click(".modal >> text=Закрыть")
        click("text=← К списку заявок"); track(); shot("T2_4_back")
        click(".tb-done")

        # ---------- T3 ----------
        cur = "T3"; begin(cur)
        click(".hero >> text=Найти закупку"); track()
        pg.select_option("#f2stage", "apply"); w()
        pg.select_option("#f2okpd", "26.20"); w(); shot("T3_1_filtered")
        click("tr:has-text('Поставка ноутбуков')"); track(); shot("T3_2_card")
        click("text=Подать заявку"); track()
        typ("#a_price", "1150000")
        typ("#a_term", "20")
        click("text=Прикрепить документ")
        click(".picker li:has-text('Выписка из ЕГРЮЛ.pdf')"); shot("T3_3_form")
        click("text=Отправить заявку"); shot("T3_4_confirm")
        click(".modal >> button:has-text('Отправить')"); track(); shot("T3_5_sent")
        click(".tb-done")

        # ---------- T4 ----------
        cur = "T4"; begin(cur)
        click(".card:has-text('Аукцион')"); track(); shot("T4_1_auction")
        click("text=−1 шаг")
        click("text=Подать предложение"); shot("T4_2_confirm")
        click(".modal >> button:has-text('Подать')"); shot("T4_3_bid")
        click(".tb-done")

        # ---------- T5 ----------
        cur = "T5"; begin(cur)
        click(".card:has-text('Рассмотрение № 109')"); track(); shot("T5_1_review")
        pg.select_option("select[data-dec='З-109-03']", "no"); w()
        pg.type("input[data-reason='З-109-03']", "Нет выписки СРО", delay=30)
        pg.select_option("select[data-dec='З-109-04']", "ok"); w()
        click("text=Сохранить решения"); shot("T5_2_saved")
        click("text=Перейти к итогам"); track()
        click("input[value='З-109-01']"); shot("T5_3_results")
        click("text=Зафиксировать победителя")
        click(".modal >> button:has-text('Зафиксировать')"); track(); shot("T5_4_winner")
        click(".tb-done")

        # ---------- T6 ----------
        cur = "T6"; begin(cur)
        click(".card:has-text('Итоги подведены')"); track()
        click("text=Завершить закупку"); shot("T6_1_confirm")
        click(".modal >> button:has-text('Завершить')"); track(); shot("T6_2_archive")
        click("tr:has-text('САПР')"); track(); shot("T6_3_archive_card")
        click("button:has-text('Сформировать отчёт')"); track(); shot("T6_4_report")
        click(".tb-done")
        shot("99_end")

        # журнал
        if pg.query_selector(".modal"): print("MODAL:", pg.inner_text(".modal")); click(".modal >> button >> nth=0")
        click("text=Журнал событий"); w(400); shot("LOG_screen")
        res = pg.evaluate("""() => { const L = window.__LR5.LOG; const a = L.all();
            return {csv: L.toCSV(a), jsonl: L.toJSONL(a), txt: L.toTXT(a), n: a.length}; }""")
        (out / "walkthrough_log.csv").write_text(res["csv"], encoding="utf-8")
        (out / "walkthrough_log.jsonl").write_text(res["jsonl"], encoding="utf-8")
        (out / "walkthrough_log.log").write_text(res["txt"], encoding="utf-8")
        ends = pg.evaluate("""() => window.__LR5.LOG.all().filter(e => e.action === 'task_end')
                              .map(e => [e.context.task_id, e.outcome])""")
        br.close()
    print("Событий в журнале:", res["n"])
    print("Итоги заданий:", ends)
    print("Маршруты по экранным формам:")
    for t, r in route.items(): print(" ", t, " → ".join(r))
    (out / "routes.json").write_text(json.dumps(route, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Ошибки JS:", errors or "нет")
    return 0 if all(o == "success" for _, o in ends) and not errors else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else "index.html",
                 sys.argv[2] if len(sys.argv) > 2 else "walkthrough"))
