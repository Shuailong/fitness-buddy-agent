// Admin › Analytics: Adoption, Usage & Quality, Agents and Value metrics
// (definitions in web/analytics.py, modelled on Gemini Enterprise analytics).
import { el, svgEl, icon, clamp } from "./util.js";
import { t, num } from "./i18n.js";

const state = {
  tab: "adoption", // adoption | usage | agents | value
  interval: "daily", // daily | weekly | monthly
  rateWindow: "7d", // 7d | 28d
};
const VALUE_KEY = "fb.admin.value";
let chartSeq = 0;

function valueSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(VALUE_KEY) || "{}");
    return { minutes: Number(raw.minutes) || 3, rate: Number(raw.rate) || 0 };
  } catch {
    return { minutes: 3, rate: 0 };
  }
}

function saveValueSettings(v) {
  try { localStorage.setItem(VALUE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

function pct(v) {
  return v === null || v === undefined ? "–" : `${v}%`;
}

function signedPct(v) {
  if (v === null || v === undefined) return "–";
  return `${v > 0 ? "+" : ""}${v}%`;
}

function segmented(items, active, onSelect) {
  return el("div", { class: "adm-pill-tabs an-seg", role: "tablist" }, items.map(([key, label]) =>
    el("button", {
      type: "button",
      role: "tab",
      class: `adm-pill-tab ${active === key ? "active" : ""}`.trim(),
      "aria-selected": String(active === key),
      onclick: () => onSelect(key),
    }, [el("span", { text: label })]),
  ));
}

function tile(label, value, sub = "", tone = "") {
  return el("div", { class: `an-tile ${tone}`.trim() }, [
    el("span", { class: "an-tile-label", text: label }),
    el("strong", { class: "an-tile-value", text: value }),
    sub ? el("span", { class: "an-tile-sub", text: sub }) : null,
  ]);
}

function card(title, sub, body, span = "adm-span-6", iconName = "monitoring") {
  return el("section", { class: `card adm-card ${span}` }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [icon(iconName, { cls: "accent" }), el("h2", { text: title })]),
        sub ? el("p", { class: "muted small adm-card-sub", text: sub }) : null,
      ]),
    ]),
    ...[].concat(body),
  ]);
}

/**
 * Area chart with hover read-out. points: [{ label, value }] (value may be
 * null = no data). tone: "" (primary) | "orange" | "violet".
 */
function areaChart(points, { format = (v) => num(v), tone = "", isPct = false } = {}) {
  const W = 640;
  const H = 200;
  const L = 42;
  const R = 12;
  const T = 14;
  const B = 26;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const vals = points.map((p) => p.value).filter((v) => v !== null && v !== undefined);
  const maxV = isPct ? Math.max(100, ...vals) : Math.max(2, ...vals) * 1.15;
  const minV = isPct ? Math.min(0, ...vals) : 0;
  const n = Math.max(points.length, 1);
  const xAt = (i) => L + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = (v) => T + plotH * (1 - clamp((v - minV) / (maxV - minV || 1), 0, 1));

  const readout = el("div", { class: "an-readout" });
  const svg = svgEl("svg", { class: `chart adm-svg-chart an-chart ${tone ? `tone-${tone}` : ""}`.trim(), viewBox: `0 0 ${W} ${H}`, role: "img" });
  const gid = `anGrad${++chartSeq}`;
  svg.append(svgEl("defs", {}, [
    svgEl("linearGradient", { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, [
      svgEl("stop", { offset: "0%", class: "an-stop-top" }),
      svgEl("stop", { offset: "100%", class: "an-stop-bottom" }),
    ]),
  ]));
  for (let i = 0; i <= 3; i++) {
    const v = minV + ((maxV - minV) * i) / 3;
    const y = yAt(v);
    svg.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: y, y2: y }));
    svg.append(svgEl("text", { class: "axis", x: L - 6, y: y + 3, "text-anchor": "end" }, isPct ? `${Math.round(v)}%` : String(Math.round(v))));
  }
  const pts = points.map((p, i) => (p.value === null || p.value === undefined ? null : [xAt(i), yAt(p.value)]));
  const known = pts.filter(Boolean);
  if (known.length > 1) {
    const d = known.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const base = yAt(Math.max(minV, 0));
    svg.append(svgEl("path", { class: "an-area", d: `${d} L${known[known.length - 1][0].toFixed(1)},${base} L${known[0][0].toFixed(1)},${base} Z`, fill: `url(#${gid})` }));
    svg.append(svgEl("path", { class: "an-line", d, fill: "none" }));
  }
  const dot = svgEl("circle", { class: "an-dot", r: 4.5, cx: -10, cy: -10 });
  svg.append(dot);
  const stride = n > 16 ? Math.ceil(n / 8) : 1;
  const show = (i) => {
    const p = points[i];
    readout.replaceChildren(el("span", { class: "muted", text: p.label }), el("b", { text: p.value === null || p.value === undefined ? "–" : format(p.value) }));
    if (pts[i]) {
      dot.setAttribute("cx", pts[i][0].toFixed(1));
      dot.setAttribute("cy", pts[i][1].toFixed(1));
    }
  };
  points.forEach((p, i) => {
    if (i % stride === 0 || i === n - 1) {
      svg.append(svgEl("text", { class: "axis", x: xAt(i), y: H - 6, "text-anchor": "middle" }, p.short || p.label));
    }
    const hit = svgEl("rect", { class: "adm-svg-hit", x: xAt(i) - plotW / n / 2, y: T, width: plotW / n, height: plotH, fill: "transparent" });
    hit.addEventListener("pointerenter", () => show(i));
    hit.addEventListener("click", () => show(i));
    svg.append(hit);
  });
  if (points.length) show(points.length - 1);
  return el("div", { class: "an-chart-wrap" }, [readout, el("div", { class: "adm-svg-wrap" }, [svg])]);
}

function bars(rows, { empty = t("adm.an.noData") } = {}) {
  if (!rows.length) return el("p", { class: "muted small", text: empty });
  const max = Math.max(1, ...rows.map((r) => r.value));
  return el("div", { class: "an-bars" }, rows.map((r) =>
    el("div", { class: "adm-bar-row" }, [
      el("div", { class: "adm-bar-head" }, [
        el("span", { class: "adm-bar-label", text: r.label }),
        el("span", { class: "adm-bar-val", text: r.text ?? num(r.value) }),
      ]),
      el("div", { class: "adm-bar-track" }, [el("span", { class: "adm-bar-fill", style: `width:${(r.value / max) * 100}%` })]),
    ]),
  ));
}

// ------------------------------------------------------------------ tabs
function adoptionPanels(an) {
  const ad = an.adoption || {};
  const seriesKey = state.interval;
  const active = (ad.active_users || {})[seriesKey] || [];
  const rates = (ad.rates || {})[state.rateWindow] || { current: {}, series: [] };
  const cur = rates.current || {};
  const n = state.rateWindow === "7d" ? 7 : 28;
  const fmtPeriod = (p) => (seriesKey === "monthly" ? p : p.slice(5));
  const lastActive = active.length ? active[active.length - 1].users : 0;
  const seats = ad.seats || {};

  const tiles = el("div", { class: "an-tiles adm-span-12" }, [
    tile(t(`adm.an.active.${seriesKey}`), num(lastActive), t("adm.an.activeSub")),
    tile(t("adm.an.growth", { n }), signedPct(cur.growth_pct), t("adm.an.vsPrev", { n }), cur.growth_pct > 0 ? "good" : cur.growth_pct < 0 ? "warn" : ""),
    tile(t("adm.an.retention", { n }), pct(cur.retention_pct), t("adm.an.retentionSub", { n })),
    tile(t("adm.an.churn", { n }), pct(cur.churn_pct), t("adm.an.churnSub", { n }), cur.churn_pct > 40 ? "warn" : ""),
    tile(t("adm.an.newUsers"), num(ad.new_users || 0), t("adm.an.inRange")),
    tile(t("adm.an.seats"), `${num(seats.claimed || 0)} / ${num(seats.granted || 0)}`, t("adm.an.seatsSub", { pct: seats.claim_rate_pct ?? 0 })),
  ]);
  const rateSeries = (key) => (rates.series || []).map((r) => ({ label: r.date, short: r.date.slice(5), value: r[key] }));
  return [
    tiles,
    card(t("adm.an.activeUsers"), t(`adm.an.activeHint.${seriesKey}`),
      areaChart(active.map((p) => ({ label: p.period, short: fmtPeriod(p.period), value: p.users }))), "adm-span-12", "trending-up"),
    card(t("adm.an.retentionRate", { n }), t("adm.an.retentionDef", { n }),
      areaChart(rateSeries("retention_pct"), { format: pct, tone: "violet", isPct: true }), "adm-span-6", "event-repeat"),
    card(t("adm.an.churnRate", { n }), t("adm.an.churnDef", { n }),
      areaChart(rateSeries("churn_pct"), { format: pct, tone: "orange", isPct: true }), "adm-span-6", "trending-down"),
  ];
}

function usagePanels(an) {
  const uq = an.usage_quality || {};
  const series = uq.series || [];
  const tiles = el("div", { class: "an-tiles adm-span-12" }, [
    tile(t("adm.an.questions"), num(uq.questions || 0), t("adm.an.questionsSub", { n: num(uq.photo_questions || 0) })),
    tile(t("adm.an.answers"), num(uq.answers || 0), t("adm.an.answerRate", { pct: uq.answer_rate_pct ?? 0 })),
    tile(t("adm.an.actions"), num(uq.actions || 0), t("adm.an.actionsSub")),
    tile(t("adm.an.successRate"), pct(uq.successful_answer_rate_pct ?? 0), t("adm.an.successSub", { n: num(uq.successful_answers || 0) }), "good"),
    tile(t("adm.an.feedback"), `👍 ${num(uq.likes || 0)} · 👎 ${num(uq.dislikes || 0)}`, t("adm.an.feedbackSub")),
  ]);
  const reasons = (uq.dislike_reasons || []).map((r) => ({ label: t(`fb.reason.${r.reason}`) === `fb.reason.${r.reason}` ? r.reason : t(`fb.reason.${r.reason}`), value: r.count, text: `${r.pct}% · ${num(r.count)}` }));
  const views = (uq.page_views || []).map((r) => ({ label: t(`nav.${r.tab}`) === `nav.${r.tab}` ? r.tab : t(`nav.${r.tab}`), value: r.count }));
  return [
    tiles,
    card(t("adm.an.questionsDaily"), t("adm.an.questionsDailyHint"),
      areaChart(series.map((d) => ({ label: d.date, short: d.date.slice(5), value: d.questions }))), "adm-span-6", "forum"),
    card(t("adm.an.successDaily"), t("adm.an.successDef"),
      areaChart(series.map((d) => ({ label: d.date, short: d.date.slice(5), value: d.answers ? Math.round((d.successful / d.answers) * 1000) / 10 : null })), { format: pct, tone: "violet", isPct: true }), "adm-span-6", "check-circle"),
    card(t("adm.an.dislikeReasons"), t("adm.an.dislikeReasonsHint"), bars(reasons), "adm-span-6", "thumb-down"),
    card(t("adm.an.pageViews"), t("adm.an.pageViewsHint"), bars(views), "adm-span-6", "event-note"),
  ];
}

function agentsPanels(an) {
  const ag = an.agents || {};
  const rows = ag.by_agent || [];
  const agentName = (a) => (t(`adm.an.agent.${a}`) === `adm.an.agent.${a}` ? a : t(`adm.an.agent.${a}`));
  const tiles = el("div", { class: "an-tiles adm-span-12" }, [
    tile(t("adm.an.agentUsers"), num(ag.active_agent_users || 0), t("adm.an.last30")),
    tile(t("adm.an.agentsUsed"), num(ag.agents_used || 0), t("adm.an.last30")),
    tile(t("adm.an.sessions"), num(ag.total_chat_sessions || 0), t("adm.an.sessionsSub")),
  ]);
  const table = rows.length
    ? el("div", { class: "an-table-wrap" }, [
      el("table", { class: "an-table" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { text: t("adm.an.colAgent") }),
          el("th", { text: t("adm.an.colUsers") }),
          el("th", { text: t("adm.an.colSessions") }),
          el("th", { text: t("adm.an.colTurns") }),
        ])]),
        el("tbody", {}, rows.map((r) => el("tr", {}, [
          el("td", { text: agentName(r.agent) }),
          el("td", { text: num(r.users) }),
          el("td", { text: num(r.sessions) }),
          el("td", { text: num(r.turns) }),
        ]))),
      ]),
    ])
    : el("p", { class: "muted small", text: t("adm.an.noData") });
  const note = ag.attributed_turns < ag.total_turns
    ? el("p", { class: "muted small an-note", text: t("adm.an.agentNote", { a: num(ag.attributed_turns || 0), n: num(ag.total_turns || 0) }) })
    : null;
  return [
    tiles,
    card(t("adm.an.byAgent"), t("adm.an.byAgentHint"), [table, note], "adm-span-7", "smart-toy"),
    card(t("adm.an.sessionsByAgent"), t("adm.an.sessionsDef"), bars(rows.map((r) => ({ label: agentName(r.agent), value: r.sessions }))), "adm-span-5", "hub"),
  ];
}

function valuePanels(an, rerender) {
  const v = an.value || {};
  const cfg = valueSettings();
  const days = v.days || 14;
  const successes = v.successful_answers || 0;
  const hours = (successes * cfg.minutes) / 60;
  const annualHours = (hours / days) * 365;
  const money = (h) => (cfg.rate > 0 ? `$${num(Math.round(h * cfg.rate))}` : "–");

  const input = (label, key, value, step) => el("label", { class: "an-input" }, [
    el("span", { class: "muted small", text: label }),
    el("input", {
      type: "number",
      min: "0",
      step,
      value: String(value || ""),
      onchange: (e) => {
        saveValueSettings({ ...valueSettings(), [key]: Number(e.target.value) || 0 });
        rerender();
      },
    }),
  ]);
  return [
    card(t("adm.an.valueAssumptions"), t("adm.an.valueAssumptionsHint"), el("div", { class: "an-inputs" }, [
      input(t("adm.an.minutesPer"), "minutes", cfg.minutes, "0.5"),
      input(t("adm.an.hourlyRate"), "rate", cfg.rate, "1"),
    ]), "adm-span-12", "tune"),
    el("div", { class: "an-tiles adm-span-12" }, [
      tile(t("adm.an.successfulAnswers"), num(successes), t("adm.an.inRangeDays", { n: days })),
      tile(t("adm.an.hoursSaved"), num(Math.round(hours * 10) / 10), t("adm.an.inRangeDays", { n: days }), "good"),
      tile(t("adm.an.valueSaved"), money(hours), cfg.rate > 0 ? t("adm.an.inRangeDays", { n: days }) : t("adm.an.setRate")),
      tile(t("adm.an.annualHours"), num(Math.round(annualHours)), t("adm.an.projected")),
      tile(t("adm.an.annualValue"), money(annualHours), cfg.rate > 0 ? t("adm.an.projected") : t("adm.an.setRate")),
    ]),
    el("p", { class: "muted small an-note adm-span-12", text: t("adm.an.valueFormula", { m: cfg.minutes }) }),
  ];
}

/** Returns the Analytics section (filters + sub-tabs + panels). */
export function renderAnalyticsSection(data, rerender) {
  const an = data.analytics;
  if (!an) return [el("p", { class: "muted", text: t("adm.an.noData") })];
  const set = (k) => (v) => { state[k] = v; rerender(); };
  const filters = el("div", { class: "an-filters adm-span-12" }, [
    segmented([
      ["adoption", t("adm.an.tab.adoption")],
      ["usage", t("adm.an.tab.usage")],
      ["agents", t("adm.an.tab.agents")],
      ["value", t("adm.an.tab.value")],
    ], state.tab, set("tab")),
    state.tab === "adoption"
      ? el("div", { class: "an-filter-group" }, [
        segmented([["daily", t("adm.an.daily")], ["weekly", t("adm.an.weekly")], ["monthly", t("adm.an.monthly")]], state.interval, set("interval")),
        segmented([["7d", "7d"], ["28d", "28d"]], state.rateWindow, set("rateWindow")),
      ])
      : null,
    el("span", { class: "muted small an-range", text: t("adm.an.range", { start: an.range.start, end: an.range.end }) }),
  ]);
  const panels = state.tab === "adoption"
    ? adoptionPanels(an)
    : state.tab === "usage"
      ? usagePanels(an)
      : state.tab === "agents"
        ? agentsPanels(an)
        : valuePanels(an, rerender);
  return [filters, ...panels];
}
