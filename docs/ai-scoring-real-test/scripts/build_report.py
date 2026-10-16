# Builds report-data.js (the numbers behind index.html) from the files in ../data. Run: python3 docs/ai-scoring-real-test/scripts/build_report.py
import json, csv, collections, statistics as st, math, os
D = os.path.join(os.path.dirname(__file__), "..")
data = lambda f: os.path.join(D, "data", f)
kws = {k["id"]: k for k in json.load(open(data("keywords.json")))}
tc2 = list(csv.DictReader(open(data("tc2-summary.csv"))))
tc3 = list(csv.DictReader(open(data("tc3-summary.csv"))))
m6 = json.load(open(data("tc6-merged.json")))
m4 = json.load(open(data("tc4-merged.json")))
t7 = json.load(open(data("tc7-contacts.json")))
yld = json.load(open(data("yield.json")))
ledger = list(csv.DictReader(open(data("ledger.csv"))))

def cls(total):
    return "Empty" if total == 0 else "Small" if total < 100 else "Medium" if total <= 1000 else "Big"
single = {r["word"]: int(r["total_entries"]) for r in tc2}
tc2rows = [{"id": r["id"], "word": r["word"], "groups": r["groups"], "total": int(r["total_entries"]), "pages": int(r["pages"]), "returned": int(r["returned"]),
            "known": int(r["known_orgs"]), "new": int(r["new"]), "with_website": int(r["with_website"]), "examples": r["examples"], "class": cls(int(r["total_entries"]))} for r in tc2]
groups = {g["id"]: g for g in json.load(open(data("groups.json")))}
tc3rows = []
for r in tc3:
    words = [w.strip() for w in r["words"].split(";")]
    known_singles = [(w, single[w]) for w in words if w in single]
    mx = max([v for _, v in known_singles], default=None)
    tc3rows.append({"id": r["id"], "group": r["group"], "words": words, "total": int(r["total_entries"]), "returned": int(r["returned"]), "new": int(r["new"]),
                    "known_singles": known_singles, "largest_single": mx, "sum_known_singles": sum(v for _, v in known_singles),
                    "verdict": "OR (any word)" if mx is not None and int(r["total_entries"]) >= mx else "AND?"})

def wilson(k, n, z=1.96):
    if n == 0: return [0, 0]
    p = k / n; d = 1 + z * z / n
    c = p + z * z / (2 * n); a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(100 * (c - a) / d, 1), round(100 * (c + a) / d, 1)]

good = [x for x in m6 if x["status"] == "good"]
gy = sum(x["plastic_label"] == "Y" for x in good); gn = sum(x["plastic_label"] == "N" for x in good); gu = sum(x["plastic_label"] == "U" for x in good)
hid = [x for x in m6 if x["status"] == "hidden"]
allY = sum(x["plastic_label"] == "Y" for x in m6)
conf = {s: {l: sum(1 for x in m6 if x["status"] == s and x["plastic_label"] == l) for l in "YNU"} for s in ["good", "review", "hidden", "flagged", "site_down"]}
cut = []
for yes in (0.55, 0.65, 0.75, 0.85, 0.90):
    g = [x for x in m6 if x["plastic"] is not None and x["plastic"] >= yes]
    h = [x for x in m6 if x["plastic"] is not None and x["plastic"] <= 0.35]
    u = [x for x in m6 if x["plastic"] is not None and 0.35 < x["plastic"] < yes]
    y = sum(x["plastic_label"] == "Y" for x in g); n = sum(x["plastic_label"] == "N" for x in g)
    cut.append({"yes_min": yes, "precision": round(100 * y / max(1, y + n), 1), "good": len(g), "wrong_N": n, "missed_Y": sum(x["plastic_label"] == "Y" for x in h), "unsure": len(u)})
byk = collections.defaultdict(list)
for x in m6: byk[x["word"]].append(x)
perk = []
for w, xs in byk.items():
    perk.append({"word": w, "n": len(xs), "reviewer_Y": sum(x["plastic_label"] == "Y" for x in xs), "ai_good": sum(x["status"] == "good" for x in xs), "on_target_Y": sum(x["on_target_label"] == "Y" for x in xs)})
perk.sort(key=lambda r: -r["reviewer_Y"] / r["n"])
wrong_good = [{"word": x["word"], "name": x["name"], "plastic": round(x["plastic"], 2), "label": x["plastic_label"], "why": x["why"]} for x in good if x["plastic_label"] != "Y"]
ai_unsure = [{"status": x["status"], "word": x["word"], "name": x["name"], "plastic": round(x["plastic"] or 0, 2), "why": x["why"], "err": x["last_error"]} for x in m6 if x["status"] in ("review", "flagged")]
p4 = []
for pg in ["p2", "p5", "p10"]:
    xs = [x for x in m4 if x["page"] == pg]; g = [x for x in xs if x["status"] == "good"]
    p4.append({"page": pg, "n": len(xs), "reviewer_Y": sum(x["plastic_label"] == "Y" for x in xs), "ai_good": len(g), "good_Y": sum(x["plastic_label"] == "Y" for x in g), "good_N": sum(x["plastic_label"] == "N" for x in g),
               "hidden_Y": sum(x["plastic_label"] == "Y" for x in xs if x["status"] == "hidden"), "on_target_Y": sum(x["on_target_label"] == "Y" for x in xs)})
rows7 = t7["rows"]; w7 = [r for r in rows7 if r["emailable"] > 0]
titles = collections.Counter(r["best_title"] for r in w7).most_common(12)
ms = [x["ms"] for x in m6 if x["ms"]]
report = {
  "generated": "2026-10-16", "tc2": tc2rows, "tc3": tc3rows, "tc6": {"n": len(m6), "confusion": conf, "good": len(good), "good_Y": gy, "good_N": gn, "good_U": gu,
     "precision_excl_U": round(100 * gy / (gy + gn), 1), "precision_ci": wilson(gy, gy + gn), "precision_strict": round(100 * gy / len(good), 1), "hidden": len(hid), "missed_Y": sum(x["plastic_label"] == "Y" for x in hid),
     "allY": allY, "unsure_pct": round(100 * sum(x["status"] == "review" for x in m6) / len(m6), 1), "flagged": sum(x["status"] == "flagged" for x in m6), "cutoffs": cut, "per_keyword": perk, "wrong_good": wrong_good, "ai_unsure": ai_unsure,
     "avg_ms": int(st.mean(ms)), "median_ms": int(st.median(ms)), "rows": [{k: x[k] for k in ["word", "name", "domain", "status", "plastic", "on_target", "score", "plastic_label", "on_target_label", "why", "text_source", "extra_sources"]} for x in m6]},
  "tc4": p4, "tc7": {"n": len(rows7), "with_email": len(w7), "rate": round(100 * len(w7) / len(rows7)), "titles": titles, "balance_before": t7["balance_before"], "balance_after": t7["balance_after"]},
  "yield": yld, "ledger": ledger,
}
open(os.path.join(D, "report-data.js"), "w").write("window.REPORT = " + json.dumps(report, ensure_ascii=False) + ";\n")
print("ok", len(json.dumps(report)) // 1024, "KB")
