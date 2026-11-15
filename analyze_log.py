"""ЛР №5 ПЧМИ. Модуль анализа лог-файла прототипа.

Читает лог-файлы в форматах CSV, JSONL и PLAIN TEXT (.log), выделяет сеансы
испытуемых и задания, определяет время выполнения каждого шага сценария
и сравнивает его с теоретической оценкой по методике GOMS (KLM).

Запуск:
    python analyze_log.py <файл или папка с логами> [--out папка] [--all]

    --all            включать служебные сеансы (прогон проектировщика «ПРОВЕРКА»)
    --exclude S1,S2  не учитывать перечисленные сеансы (например, пробные)

Результат: таблицы в консоли и файлы observations.csv, steps.csv, summary.json
(и диаграмма times.png, если установлен matplotlib).
"""
import csv, json, re, sys, statistics
from collections import defaultdict, OrderedDict
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Операторы GOMS (KLM), значения по методическим указаниям, секунды
# ---------------------------------------------------------------------------
OPS = {
    "H": 0.4,   # перемещение руки к мыши / клавиатуре
    "M": 1.2,   # обдумывание
    "P": 1.1,   # позиционирование курсора
    "K": 0.4,   # клик мышью
    "T": 0.28,  # набор одного символа
    "L": 0.4,   # выбор значения из списка
}

def goms(ops):
    """ops: строка вида 'H M P K T29' -> время, с."""
    t = 0.0
    for tok in ops.split():
        m = re.fullmatch(r"([HMPKTL])(\d*)", tok)
        t += OPS[m.group(1)] * (int(m.group(2)) if m.group(2) else 1)
    return round(t, 2)

T = lambda s: f"T{len(s)}"

# ---------------------------------------------------------------------------
# Тестовые задания: шаги, операторы GOMS и событие лога, завершающее шаг.
# Событие-веха: (action, object_id | None, подстрока detail | None, outcome | None)
# ---------------------------------------------------------------------------
TASKS = OrderedDict()
TASKS["T1"] = dict(title="Создание и публикация закупки", role="Заказчик", scenario="Сценарий 1", steps=[
    ("Открыть форму новой закупки (кнопка «Создать закупку»)", "H M P K", ("purchase_form_open", None, None, None)),
    ("Ввести наименование «Поставка канцелярских товаров»", "H " + T("Поставка канцелярских товаров"), ("field_change", "name", None, None)),
    ("Ввести НМЦК «450000»", "H P K H " + T("450000"), ("field_change", "nmck", None, None)),
    ("Выбрать способ «Электронный аукцион»", "H P K L", ("field_change", "method", None, None)),
    ("Ввести срок «25.11.2026»", "P K H " + T("25.11.2026"), ("field_change", "deadline", None, None)),
    ("Прикрепить «Техническое задание.pdf»", "H M P K P K", ("file_attach", None, None, None)),
    ("Сохранить черновик", "P K", ("purchase_save_draft", None, None, None)),
    ("Нажать «Опубликовать»", "M P K", ("confirm_open", None, None, None)),
    ("Подтвердить публикацию", "P K", ("purchase_publish", None, None, "success")),
])
TASKS["T2"] = dict(title="Просмотр поступивших заявок", role="Заказчик", scenario="Сценарий 2", steps=[
    ("Открыть карточку закупки № 0301-2026-117", "H M P K", ("screen_open", "F3", "0301-2026-117", None)),
    ("Перейти к списку заявок", "M P K", ("applications_open", None, None, None)),
    ("Отфильтровать по статусу «Подана»", "P K L", ("filter_apply", "st", None, None)),
    ("Упорядочить по возрастанию цены", "P K L", ("filter_apply", "sort", None, None)),
    ("Открыть заявку ООО «ЧистоДом»", "M P K", ("screen_open", "F5", "З-117-01", None)),
    ("Открыть документ «Лицензия.pdf»", "M P K", ("document_view", "Лицензия.pdf", None, None)),
    ("Закрыть документ", "P K", ("document_close", "Лицензия.pdf", None, None)),
    ("Вернуться к списку заявок", "P K", ("back_to_list", None, None, None)),
])
TASKS["T3"] = dict(title="Поиск закупки и подача заявки", role="Поставщик", scenario="Сценарии 3, 4", steps=[
    ("Открыть список закупок", "H M P K", ("screen_open", "F2", None, None)),
    ("Выбрать этап «Подача заявок»", "P K L", ("filter_apply", "stage", None, None)),
    ("Выбрать ОКПД2 «26.20»", "P K L", ("filter_apply", "okpd", None, None)),
    ("Найти в списке и открыть закупку", "M P K", ("screen_open", "F3", "0405-2026-125", None)),
    ("Нажать «Подать заявку»", "M P K", ("application_create", None, None, None)),
    ("Ввести цену «1150000»", "H " + T("1150000"), ("field_change", "price", None, None)),
    ("Ввести срок поставки «20»", "H P K H " + T("20"), ("field_change", "term", None, None)),
    ("Прикрепить «Выписка из ЕГРЮЛ.pdf»", "H P K M P K", ("file_attach", None, None, None)),
    ("Нажать «Отправить заявку»", "P K", ("confirm_open", None, None, None)),
    ("Подтвердить отправку", "P K", ("application_send", None, None, "success")),
])
TASKS["T4"] = dict(title="Участие в аукционе", role="Поставщик", scenario="Сценарий 5", steps=[
    ("Перейти к аукциону", "H M P K", ("screen_open", "F6", None, None)),
    ("Определить цену, нажать «−1 шаг»", "M P K", ("bid_step_click", None, None, None)),
    ("Нажать «Подать предложение»", "P K", ("confirm_open", None, None, None)),
    ("Подтвердить подачу", "P K", ("bid_submit", None, None, "success")),
])
TASKS["T5"] = dict(title="Рассмотрение заявок и выбор победителя", role="Комиссия", scenario="Сценарий 6", steps=[
    ("Открыть рассмотрение по закупке № 0301-2026-109", "H M P K", ("screen_open", "F7D", "0301-2026-109", None)),
    ("Решение по заявке ИП Гарипов: «Не соответствует»", "M P K L", ("decision_set", "З-109-03", None, None)),
    ("Ввести основание «Нет выписки СРО»", "H " + T("Нет выписки СРО"), ("field_change", "З-109-03", None, None)),
    ("Решение по заявке ООО «Уфа-Ремонт»: «Соответствует»", "H P K L", ("decision_set", "З-109-04", None, None)),
    ("Сохранить решения", "P K", ("review_save", None, None, "success")),
    ("Перейти к итогам", "P K", ("screen_open", "F8", None, None)),
    ("Выбрать участника с наименьшей ценой", "M P K", ("winner_select", None, None, None)),
    ("Нажать «Зафиксировать победителя»", "P K", ("confirm_open", None, None, None)),
    ("Подтвердить", "P K", ("winner_fix", None, None, "success")),
])
TASKS["T6"] = dict(title="Завершение закупки и отчёт из архива", role="Заказчик", scenario="Сценарии 7, 8", steps=[
    ("Открыть карточку закупки № 0301-2026-098", "H M P K", ("screen_open", "F3", "0301-2026-098", None)),
    ("Нажать «Завершить закупку»", "M P K", ("confirm_open", None, None, None)),
    ("Подтвердить завершение (переход в архив)", "P K", ("purchase_complete", None, None, "success")),
    ("Найти закупку в архиве и открыть карточку", "M P K", ("screen_open", "F10", "0301-2026-098", None)),
    ("Нажать «Сформировать отчёт»", "M P K", ("report_generate", None, None, None)),
])
for t in TASKS.values():
    t["goms"] = [goms(s[1]) for s in t["steps"]]
    t["goms_total"] = round(sum(t["goms"]), 2)

SERVICE_ACTORS = {"ПРОВЕРКА"}

# ---------------------------------------------------------------------------
# Чтение лог-файлов трёх форматов -> единый список событий
# ---------------------------------------------------------------------------
def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def norm(timestamp, actor, role, action, otype, oid, outcome, changes, ctx):
    return dict(t=ts(timestamp), timestamp=timestamp, actor=actor, role=role, action=action,
                otype=otype, oid=oid or "", outcome=outcome, changes=changes or {},
                session=ctx.get("session_id") or ctx.get("correlation_id") or "",
                task=ctx.get("task_id") or "", screen=ctx.get("screen") or "",
                detail=str(ctx.get("detail") or ""), error=ctx.get("error") or "")

def read_csv(path):
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            ctx = json.loads(r["context"]) if r.get("context") else {}
            ch = json.loads(r["changes"]) if r.get("changes") else {}
            out.append(norm(r["timestamp"], r["actor_id"], r["actor_role"], r["action"],
                            r["object_type"], r["object_id"], r["outcome"], ch, ctx))
    return out

def read_jsonl(path):
    out = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        out.append(norm(o["timestamp"], o["actor"]["id"], o["actor"]["role"], o["action"],
                        o["object"]["type"], o["object"]["id"], o["outcome"], o.get("changes"), o.get("context", {})))
    return out

KV = re.compile(r'(\S+?)=("(?:[^"\\]|\\.)*"|\S+)')

def read_txt(path):
    out = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if not re.match(r"\d{4}-\d{2}-\d{2}T", line):   # не запись журнала (например, README.txt)
            continue
        stamp, rest = line.split(None, 1)
        kv = {}
        for k, v in KV.findall(rest):
            if v.startswith('"'):
                try: v = json.loads(v)
                except Exception: v = v.strip('"')
            kv[k] = v
        otype, _, oid = kv.get("object", ":").partition(":")
        ctx = dict(session_id=kv.get("corr"), task_id=None if kv.get("task") == "-" else kv.get("task"),
                   screen=kv.get("screen"), detail=kv.get("detail"), error=kv.get("error"))
        ch = {k[7:]: v for k, v in kv.items() if k.startswith("change.")}
        out.append(norm(stamp, kv.get("actor", ""), kv.get("role", ""), kv.get("action", ""),
                        otype, "" if oid == "-" else oid, kv.get("outcome", ""), ch, ctx))
    return out

def read_db_export(path):
    """JSON-документ задания, выгруженный из базы страницы (поле events)."""
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    d = d.get("data", d)
    return [norm(e["timestamp"], e["actor_id"], e["actor_role"], e["action"], e["object_type"],
                 e["object_id"], e["outcome"], e.get("changes"), e.get("context", {})) for e in d.get("events", [])]

READERS = {".csv": read_csv, ".jsonl": read_jsonl, ".log": read_txt, ".txt": read_txt, ".json": read_db_export}

def load(path):
    p = Path(path)
    files = [p] if p.is_file() else sorted(x for x in p.rglob("*") if x.suffix.lower() in READERS)
    events, seen = [], set()
    for f in files:
        for e in READERS[f.suffix.lower()](f):
            key = (e["timestamp"], e["actor"], e["action"], e["oid"], e["session"])
            if key not in seen:               # один и тот же сеанс мог быть выгружен в нескольких форматах
                seen.add(key); events.append(e)
    events.sort(key=lambda e: e["t"])
    return events, files

# ---------------------------------------------------------------------------
# Разбор: сеансы -> задания -> шаги
# ---------------------------------------------------------------------------
def match(e, spec):
    action, oid, detail, outcome = spec
    return (e["action"] == action and (oid is None or e["oid"] == oid)
            and (detail is None or detail in e["detail"]) and (outcome is None or e["outcome"] == outcome))

def analyze(events, include_service=False, exclude=()):
    sessions = defaultdict(list)
    for e in events:
        if e["session"].startswith("S") and e["session"] not in exclude:
            sessions[e["session"]].append(e)
    result = []
    for sid, evs in sessions.items():
        start = next((e for e in evs if e["action"] == "session_start"), None)
        actor = (start or evs[0])["actor"]
        if actor in SERVICE_ACTORS and not include_service:
            continue
        info = dict(session=sid, actor=actor, service=actor in SERVICE_ACTORS,
                    experience=(start["changes"].get("experience", "") if start else ""),
                    pc=(start["changes"].get("pc_level", "") if start else ""), tasks={})
        for tid, task in TASKS.items():
            te = [e for e in evs if e["task"] == tid]
            t0 = next((e["t"] for e in te if e["action"] == "task_start"), None)
            end = next((e for e in te if e["action"] == "task_end"), None)
            if t0 is None or end is None:
                continue
            goal = next((e["t"] for e in te if e["action"] == "goal_reached"), None)
            t_fin = goal if goal is not None else end["t"]
            found = []
            for i, (_, _, spec) in enumerate(task["steps"]):
                hit = next((e["t"] for e in te if e["t"] >= t0 and match(e, spec)), None)
                if hit is not None:
                    found.append((hit, i))
            found.sort()
            steps = [None] * len(task["steps"])
            prev = t0
            for hit, i in found:
                steps[i] = round(hit - prev, 3); prev = hit
            info["tasks"][tid] = dict(
                outcome=end["outcome"], time=round(t_fin - t0, 3), time_to_done_click=round(end["t"] - t0, 3),
                steps=steps,
                errors=sum(1 for e in te if e["outcome"] == "failure" and e["action"] not in ("task_end",)),
                hints=sum(1 for e in te if e["action"] == "task_hint_open"),
                events=len(te))
        if info["tasks"]:
            result.append(info)
    result.sort(key=lambda s: s["session"])
    return result

def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.mean(xs), 2) if xs else None

def fmt(x):
    return "—" if x is None else f"{x:.1f}".replace(".", ",")

def report(res, out_dir=None):
    people = res
    names = [f"{s['actor']}" for s in people]
    print("\nИспытуемые:")
    for s in people:
        print(f"  {s['actor']:<10} сеанс {s['session']}  ПК: {s['pc'] or '—'}; опыт: {s['experience'] or '—'}")

    print("\nТаблица 1. Время выполнения сценариев, с (до достижения цели задания)")
    head = f"{'Задание':<8}" + "".join(f"{n:>10}" for n in names) + f"{'Среднее':>10}{'GOMS':>8}{'Факт/GOMS':>11}"
    print(head); print("-" * len(head))
    obs_rows = []
    for tid, task in TASKS.items():
        vals = [s["tasks"][tid]["time"] if tid in s["tasks"] and s["tasks"][tid]["outcome"] == "success" else None for s in people]
        m = mean(vals)
        ratio = round(m / task["goms_total"], 2) if m else None
        print(f"{tid:<8}" + "".join(f"{fmt(v):>10}" for v in vals) + f"{fmt(m):>10}{fmt(task['goms_total']):>8}{fmt(ratio):>11}")
        obs_rows.append([tid, task["title"]] + vals + [m, task["goms_total"], ratio])
    print("(«—» — задание не выполнено или пропущено)")

    print("\nОшибки и обращения к тексту задания:")
    for tid in TASKS:
        errs = [s["tasks"].get(tid, {}).get("errors") for s in people]
        hints = [s["tasks"].get(tid, {}).get("hints") for s in people]
        ok = sum(1 for s in people if s["tasks"].get(tid, {}).get("outcome") == "success")
        print(f"  {tid}: выполнили {ok} из {len(people)}; ошибок: {errs}; открытий текста задания: {hints}")

    print("\nВремя по шагам (среднее по испытуемым) и оценка GOMS, с")
    step_rows = []
    for tid, task in TASKS.items():
        print(f"\n{tid}. {task['title']} ({task['role']}, {task['scenario']})")
        for i, (name, ops, _) in enumerate(task["steps"]):
            vals = [s["tasks"][tid]["steps"][i] for s in people if tid in s["tasks"]]
            m = mean(vals)
            g = task["goms"][i]
            flag = "  <-- дольше GOMS более чем в 2 раза" if m and m > 2 * g else ""
            print(f"  {i+1:>2}. {name:<58} GOMS {fmt(g):>5}  факт {fmt(m):>6}{flag}")
            step_rows.append([tid, i + 1, name, ops, g, m] + vals)
        print(f"      {'Итого по GOMS':<58} {fmt(task['goms_total']):>10}")

    if out_dir:
        out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
        with open(out / "observations.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["Задание", "Название"] + names + ["Среднее", "GOMS", "Факт/GOMS"]); w.writerows(obs_rows)
        with open(out / "steps.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["Задание", "Шаг", "Действие", "Операторы", "GOMS", "Среднее"] + names); w.writerows(step_rows)
        (out / "summary.json").write_text(json.dumps(dict(
            goms={t: dict(total=v["goms_total"], steps=v["goms"]) for t, v in TASKS.items()}, sessions=people),
            ensure_ascii=False, indent=1), encoding="utf-8")
        try:
            import matplotlib; matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            tids = list(TASKS)
            g = [TASKS[t]["goms_total"] for t in tids]
            m = [r[-3] or 0 for r in obs_rows]
            x = range(len(tids)); fig, ax = plt.subplots(figsize=(8, 4.2), dpi=150)
            ax.bar([i - 0.2 for i in x], g, 0.4, label="Оценка GOMS", color="#4A6A88")
            ax.bar([i + 0.2 for i in x], m, 0.4, label="Среднее фактическое", color="#6B1E36")
            for i, s in enumerate(people):
                ys = [s["tasks"][t]["time"] if t in s["tasks"] and s["tasks"][t]["outcome"] == "success" else None for t in tids]
                ax.scatter([j + 0.2 for j, y in enumerate(ys) if y is not None], [y for y in ys if y is not None],
                           s=14, color="#142233", zorder=3, label="Отдельные сеансы" if i == 0 else None)
            ax.set_xticks(list(x)); ax.set_xticklabels(tids); ax.set_ylabel("Время, с")
            ax.set_title("Время выполнения заданий: оценка GOMS и фактическое время")
            ax.grid(axis="y", alpha=.3); ax.legend(frameon=False)
            fig.tight_layout(); fig.savefig(out / "times.png"); plt.close(fig)
        except ImportError:
            pass
        print(f"\nФайлы сохранены в {out}")


def main(argv):
    if len(argv) < 2:
        print(__doc__); return 2
    out = argv[argv.index("--out") + 1] if "--out" in argv else None
    events, files = load(argv[1])
    print(f"Прочитано файлов: {len(files)}, событий: {len(events)}")
    excl = argv[argv.index("--exclude") + 1].split(",") if "--exclude" in argv else ()
    res = analyze(events, include_service="--all" in argv, exclude=excl)
    if not res:
        print("Сеансы испытуемых с завершёнными заданиями не найдены."
              " (Служебный прогон «ПРОВЕРКА» показывается с ключом --all.)")
        print("\nОценка GOMS по заданиям, с:")
        for tid, t in TASKS.items(): print(f"  {tid}  {t['goms_total']:>6}  {t['title']}")
        return 0
    report(res, out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
