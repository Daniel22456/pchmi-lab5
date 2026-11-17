"""ЛР №6 ПЧМИ. Оценка эффективности интерфейса на основе тестирования.

По лог-файлам прототипа (ЛР5) для каждого сценария:
  1) составляет таблицу затрат времени испытуемых x1..xn;
  2) считает среднее время и исправленное СКО;
  3) проверяет гипотезу H0: M(X) = a0 (a0 — время по GOMS) одновыборочным
     критерием Стьюдента при альтернативе H1: M(X) ≠ a0;
  4) строит доверительный интервал для среднего и проверяет, входит ли в него a0.

Запуск:
    python stats_lab6.py <файл или папка с логами> [--alpha 0.05] [--out папка]
                         [--include-ai] [--exclude S1,S2]

Время сценария берётся из лога как интервал task_start → goal_reached
(задание засчитывается, только если его цель достигнута).
Служебный прогон «ПРОВЕРКА» и прогоны ИИ-ассистента (код AI-…) по умолчанию
не учитываются: в выборку входят только испытуемые-люди.
"""
import json, math, sys, csv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze_log as AL                      # модуль анализа лога из ЛР5

try:
    from scipy import stats as _st
    def t_crit(alpha, k, two_sided=True):
        return float(_st.t.ppf(1 - alpha / 2 if two_sided else 1 - alpha, k))
except ImportError:                           # таблица критических точек, α = 0,05
    _T2 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262,
           10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110,
           18: 2.101, 19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042}
    def t_crit(alpha, k, two_sided=True):
        if abs(alpha - 0.05) > 1e-9 or not two_sided:
            raise SystemExit("Без scipy поддерживается только α = 0,05 (двусторонний критерий)")
        return _T2.get(k) or _T2[min(_T2, key=lambda x: abs(x - k))]

MIN_N = 10


def scenario_stats(x, a0, alpha):
    """x — выборка времени, a0 — время по GOMS."""
    n = len(x)
    mean = sum(x) / n
    s2 = sum((v - mean) ** 2 for v in x) / (n - 1)      # исправленная дисперсия
    s = math.sqrt(s2)
    se = s / math.sqrt(n)
    k = n - 1
    tcr = t_crit(alpha, k)
    t_obs = (mean - a0) / se
    lo, hi = mean - tcr * se, mean + tcr * se
    return dict(n=n, x=x, mean=mean, s2=s2, s=s, se=se, k=k, alpha=alpha, a0=a0,
                t_obs=t_obs, t_cr=tcr, h0=abs(t_obs) < tcr, ci=(lo, hi), a0_in_ci=lo < a0 < hi,
                t_right=t_crit(alpha, k, two_sided=False))


def collect(path, include_ai=False, exclude=()):
    events, files = AL.load(path)
    sessions = AL.analyze(events, include_service=False, exclude=exclude)
    if not include_ai:
        sessions = [s for s in sessions if not s["actor"].upper().startswith("AI")]
    return sessions, files


def compute(sessions, alpha):
    res = {}
    for tid, task in AL.TASKS.items():
        rows = [(s["actor"], s["tasks"][tid]["time"]) for s in sessions
                if tid in s["tasks"] and s["tasks"][tid]["outcome"] == "success"]
        failed = [s["actor"] for s in sessions if tid in s["tasks"] and s["tasks"][tid]["outcome"] != "success"]
        r = dict(task=tid, title=task["title"], goms=task["goms_total"], rows=rows, failed=failed)
        if len(rows) >= 2:
            r.update(scenario_stats([v for _, v in rows], task["goms_total"], alpha))
        res[tid] = r
    return res


def f(x, d=2):
    return f"{x:.{d}f}".replace(".", ",")


def print_report(res, sessions, alpha):
    print(f"Испытуемых в выборке: {len(sessions)}; уровень значимости α = {f(alpha)}")
    if len(sessions) < MIN_N:
        print(f"ВНИМАНИЕ: по заданию нужно не менее {MIN_N} участников, сейчас {len(sessions)}.")
    for tid, r in res.items():
        print(f"\n{tid}. {r['title']}  (GOMS a0 = {f(r['goms'])} с)")
        print("  №:     " + "".join(f"{i+1:>8}" for i in range(len(r["rows"]))))
        print("  Время: " + "".join(f"{f(v, 1):>8}" for _, v in r["rows"]))
        if r["failed"]:
            print(f"  Не выполнили: {', '.join(r['failed'])}")
        if "mean" not in r:
            print("  Недостаточно данных для расчёта."); continue
        print(f"  x̄ = {f(r['mean'])} с;  S² = {f(r['s2'])};  S = {f(r['s'])} с;  k = n − 1 = {r['k']}")
        print(f"  Tнабл = (x̄ − a0)/(S/√n) = ({f(r['mean'])} − {f(r['goms'])})/({f(r['s'])}/√{r['n']}) = {f(r['t_obs'], 3)}")
        print(f"  tдвуст.кр(α={f(alpha)}; k={r['k']}) = {f(r['t_cr'], 3)}  →  |Tнабл| {'<' if r['h0'] else '>'} tкр:"
              f" H0 {'принимается' if r['h0'] else 'отвергается'}")
        lo, hi = r["ci"]
        print(f"  Доверительный интервал (γ = {f(1-alpha)}): {f(lo)} < m < {f(hi)};"
              f" a0 = {f(r['goms'])} {'входит' if r['a0_in_ci'] else 'НЕ входит'} в интервал")


def save(res, sessions, alpha, out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    payload = dict(alpha=alpha, n_sessions=len(sessions),
                   sessions=[dict(actor=s["actor"], session=s["session"], pc=s["pc"], experience=s["experience"]) for s in sessions],
                   scenarios={t: {k: v for k, v in r.items()} for t, r in res.items()})
    (out / "stats.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=list), encoding="utf-8")
    with open(out / "stats.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["Сценарий", "n", "Среднее, с", "S, с", "GOMS, с", "Tнабл", "tкр", "H0", "ДИ от", "ДИ до", "GOMS в ДИ"])
        for t, r in res.items():
            if "mean" in r:
                w.writerow([t, r["n"], f(r["mean"]), f(r["s"]), f(r["goms"]), f(r["t_obs"], 3), f(r["t_cr"], 3),
                            "принимается" if r["h0"] else "отвергается", f(r["ci"][0]), f(r["ci"][1]),
                            "да" if r["a0_in_ci"] else "нет"])
    try:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        ts = [t for t, r in res.items() if "mean" in r]
        if ts:
            fig, ax = plt.subplots(figsize=(8, 4.2), dpi=150)
            for i, t in enumerate(ts):
                r = res[t]; lo, hi = r["ci"]
                ax.plot([i, i], [lo, hi], color="#142233", lw=2)
                ax.plot([i - .12, i + .12], [lo, lo], color="#142233", lw=2)
                ax.plot([i - .12, i + .12], [hi, hi], color="#142233", lw=2)
                ax.scatter([i], [r["mean"]], color="#142233", zorder=3, label="Среднее и доверительный интервал" if i == 0 else None)
                ax.scatter([i], [r["goms"]], marker="D", color="#6B1E36", zorder=4, label="Оценка GOMS" if i == 0 else None)
                ax.scatter([i + .22] * r["n"], r["x"], s=8, color="#4A6A88", alpha=.7, label="Испытуемые" if i == 0 else None)
            ax.set_xticks(range(len(ts))); ax.set_xticklabels(ts); ax.set_ylabel("Время, с")
            ax.set_title(f"Доверительные интервалы среднего времени (γ = {1-alpha:.2f}) и оценка GOMS")
            ax.grid(axis="y", alpha=.3); ax.legend(frameon=False, fontsize=8)
            fig.tight_layout(); fig.savefig(out / "ci.png"); plt.close(fig)
    except ImportError:
        pass
    print(f"\nФайлы сохранены в {out}")


def main(argv):
    if len(argv) < 2:
        print(__doc__); return 2
    alpha = float(argv[argv.index("--alpha") + 1]) if "--alpha" in argv else 0.05
    excl = argv[argv.index("--exclude") + 1].split(",") if "--exclude" in argv else ()
    sessions, files = collect(argv[1], "--include-ai" in argv, excl)
    print(f"Прочитано файлов: {len(files)}")
    if not sessions:
        print("Сеансы испытуемых не найдены (прогоны ИИ учитываются только с ключом --include-ai)."); return 1
    res = compute(sessions, alpha)
    print_report(res, sessions, alpha)
    if "--out" in argv:
        save(res, sessions, alpha, argv[argv.index("--out") + 1])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
