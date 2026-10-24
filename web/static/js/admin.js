// Admin Console view (#admin): modern, minimalist, responsive & interactive operational dashboard.
import { el, svgEl, icon, clamp } from "./util.js";
import { api, getJson } from "./api.js";
import { t, getLang, num, dateShort } from "./i18n.js";
import { miniRing } from "./charts.js";
import { loadingView, errorView } from "./views.js";
import { renderAnalyticsSection } from "./admin-analytics.js";

let cachedOverview = null;
let currentDays = 14;
let activeSectionTab = "overview"; // "overview" | "analytics" | "access" | "growth" | "ai"
let activeAccessFilter = "all"; // "all" | "pending" | "approved" | "revoked"
let accessSearchQuery = "";
let activeGrowthMode = "dau"; // "dau" | "activity" | "cost"
let selectedFunnelIdx = 0;
let activeGeoTab = "country"; // "country" | "tz" | "lang"
let activeFeatureTab = "intents"; // "intents" | "tabs" | "events"
let hoveredDonutIdx = -1;
let loading = false;
let lastRefreshedAt = null;
let gradSeq = 0;

function fmtUsd(val, digits = 4) {
  const n = Number(val) || 0;
  return n.toFixed(digits);
}

function fmtClockSec(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(getLang() === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtAgo(seconds) {
  const zh = getLang() === "zh";
  if (seconds === null || seconds === undefined || seconds > 86400 * 60) return zh ? "未活跃" : "–";
  if (seconds < 60) return zh ? "刚刚" : "just now";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return zh ? `${m} 分钟前` : `${m}m ago`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return zh ? `${h} 小时前` : `${h}h ago`;
  }
  const d = Math.floor(seconds / 86400);
  return zh ? `${d} 天前` : `${d}d ago`;
}

function smoothCurve(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function barRow(label, rightText, pct, tone = "", subLabel = "") {
  const w = clamp(Number(pct) || 0, 0, 100);
  return el("div", { class: "adm-bar-row" }, [
    el("div", { class: "adm-bar-head" }, [
      el("span", { class: "adm-bar-label" }, [
        el("span", { text: label }),
        subLabel ? el("span", { class: "adm-bar-sub muted small", text: ` · ${subLabel}` }) : null,
      ]),
      el("span", { class: "adm-bar-val", text: rightText }),
    ]),
    el("div", { class: "adm-bar-track" }, [
      el("span", { class: `adm-bar-fill ${tone}`.trim(), style: `width:${w}%` }),
    ]),
  ]);
}

function pillTabs(items, activeKey, onSelect, extraCls = "") {
  return el(
    "div",
    { class: `adm-pill-tabs ${extraCls}`.trim(), role: "tablist" },
    items.map(([key, label, badge]) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          class: `adm-pill-tab ${activeKey === key ? "active" : ""}`.trim(),
          "aria-selected": String(activeKey === key),
          onclick: () => onSelect(key),
        },
        [
          el("span", { text: label }),
          badge !== undefined && badge !== null
            ? el("span", { class: "adm-pill-count", text: String(badge) })
            : null,
        ],
      ),
    ),
  );
}

/** Top 4 Bento KPI Cards */
function renderBentoKpis(data, root, showToast) {
  const s = data.summary || {};
  const mc = data.model_stability_and_cost || {};
  const sys = data.system_stability || {};
  const lat = sys.latency_overall || {};
  const fb = data.feedback || {};
  const zh = getLang() === "zh";

  const profilePct = s.total_users ? Math.round(((s.profiled_users || 0) / s.total_users) * 100) : 0;
  const okPct = Math.round(mc.success_rate_pct ?? 100);

  // 1. Live Presence & Active Users
  const cardOnline = el("div", { class: "card adm-bento-kpi highlight" }, [
    el("div", { class: "adm-kpi-head" }, [
      el("span", { class: "adm-kpi-title" }, [
        el("i", { class: "adm-dot is-online" }),
        el("span", { text: t("adm.kpi.online") }),
      ]),
      el("span", { class: "pill pill-primary", text: t("adm.kpi.onlineSub", { n: num(s.active_15m || 0) }) }),
    ]),
    el("div", { class: "adm-kpi-main" }, [
      el("div", { class: "adm-kpi-big", text: num(s.online_now_5m || 0) }),
      el("div", { class: "adm-kpi-meta" }, [
        el("span", { class: "muted small", text: t("adm.kpi.active") }),
        el("strong", { text: `${num(s.dau || 0)} / ${num(s.wau || 0)} / ${num(s.mau || 0)}` }),
      ]),
    ]),
    el("div", { class: "adm-kpi-foot" }, [
      el("span", { class: "muted small", text: t("adm.kpi.activeSub", { pct: s.stickiness_pct ?? 0 }) }),
      el("span", { class: "adm-mini-tag", text: `DAU ${num(s.dau || 0)}` }),
    ]),
  ]);

  // 2. Total Users, Onboarding Ring & Retention
  const cardUsers = el("div", { class: "card adm-bento-kpi" }, [
    el("div", { class: "adm-kpi-head" }, [
      el("span", { class: "adm-kpi-title" }, [
        icon("verified-user", { cls: "accent" }),
        el("span", { text: t("adm.kpi.users") }),
      ]),
      s.waitlist_pending > 0
        ? el(
            "button",
            {
              type: "button",
              class: "adm-waitlist-alert",
              onclick: () => {
                activeSectionTab = "access";
                activeAccessFilter = "pending";
                paintAdmin(root, cachedOverview, showToast);
              },
            },
            [
              icon("shield"),
              el("span", { text: `${num(s.waitlist_pending)} ${zh ? "待审批" : "Pending"}` }),
            ],
          )
        : el("span", { class: "tag-muted", text: `${num(s.waitlist_approved || 0)} ${zh ? "白名单" : "Allowed"}` }),
    ]),
    el("div", { class: "adm-kpi-main with-ring" }, [
      el("div", {}, [
        el("div", { class: "adm-kpi-big", text: num(s.total_users || 0) }),
        el("p", { class: "muted small", text: `${num(s.profiled_users || 0)} ${zh ? "已建档" : "profiled"} (${profilePct}%)` }),
      ]),
      el("div", { class: "ring-wrap adm-ring-sm" }, [
        miniRing(s.profiled_users || 0, Math.max(s.total_users || 1, 1), { size: 58, stroke: 10 }),
        el("div", { class: "ring-center", "aria-hidden": "true" }, [
          el("span", { class: "adm-ring-txt", text: `${profilePct}%` }),
        ]),
      ]),
    ]),
    el("div", { class: "adm-kpi-foot" }, [
      el("span", { class: "adm-ret-pill", text: `D1 ${s.d1_retention_pct ?? 0}%` }),
      el("span", { class: "adm-ret-pill", text: `D7 ${s.d7_retention_pct ?? 0}%` }),
      el("span", { class: "muted small adm-ml-auto", text: `${zh ? "留存率" : "Retention"}` }),
    ]),
  ]);

  // 3. Model Stability & Cost
  const cardModel = el("div", { class: "card adm-bento-kpi" }, [
    el("div", { class: "adm-kpi-head" }, [
      el("span", { class: "adm-kpi-title" }, [
        icon("auto-awesome", { cls: "accent" }),
        el("span", { text: t("adm.kpi.cost") }),
      ]),
      el("span", { class: "pill pill-outline", text: `${okPct}% OK` }),
    ]),
    el("div", { class: "adm-kpi-main with-ring" }, [
      el("div", {}, [
        el("div", { class: "adm-kpi-big", text: `$${fmtUsd(mc.cost_mtd_usd, 4)}` }),
        el("p", {
          class: "muted small",
          text: t("adm.kpi.costSub", {
            today: fmtUsd(mc.cost_today_usd, 4),
            budget: fmtUsd(mc.monthly_budget_usd || 100, 0),
          }),
        }),
      ]),
      el("div", { class: "ring-wrap adm-ring-sm" }, [
        miniRing(okPct, 100, { size: 58, stroke: 10 }),
        el("div", { class: "ring-center", "aria-hidden": "true" }, [
          el("span", { class: "adm-ring-txt", text: `${okPct}%` }),
        ]),
      ]),
    ]),
    el("div", { class: "adm-kpi-foot" }, [
      el("span", {
        class: "muted small",
        text: t("adm.kpi.modelOkSub", {
          turns: num(mc.total_turns || 0),
          photos: num(mc.photo_turns || 0),
        }),
      }),
      el("span", { class: "adm-mini-tag", text: `${num(mc.est_total_tokens || 0)} tok` }),
    ]),
  ]);

  // 4. System SLA, Latency & CSAT
  const cardSys = el("div", { class: "card adm-bento-kpi" }, [
    el("div", { class: "adm-kpi-head" }, [
      el("span", { class: "adm-kpi-title" }, [
        icon("timer", { cls: "accent" }),
        el("span", { text: t("adm.kpi.latency") }),
      ]),
      el("span", {
        class: `pill ${sys.status === "healthy" ? "pill-primary" : "pill-warn"}`,
        text: `${sys.uptime_pct ?? 100}% SLA`,
      }),
    ]),
    el("div", { class: "adm-kpi-main" }, [
      el("div", { class: "adm-kpi-big" }, [
        el("span", { text: `${num(lat.p50_ms || 0)}` }),
        el("span", { class: "adm-kpi-unit", text: ` / ${num(lat.p95_ms || 0)} ms` }),
      ]),
      el("div", { class: "adm-kpi-meta" }, [
        el("span", { class: "muted small", text: "CSAT" }),
        el("strong", { text: `${fb.satisfaction_pct ?? 100}% (👍 ${num(fb.up_count || 0)})` }),
      ]),
    ]),
    el("div", { class: "adm-kpi-foot" }, [
      el("span", {
        class: "muted small",
        text: t("adm.kpi.latencySub", { avg: num(lat.avg_ms || 0), max: num(lat.max_ms || 0) }),
      }),
      el("span", { class: "adm-mini-tag", text: t(`adm.${sys.status || "healthy"}`) }),
    ]),
  ]);

  return el("div", { class: "adm-bento-kpis" }, [cardOnline, cardUsers, cardModel, cardSys]);
}

/** Interactive SVG Trend Chart (Growth / Activity / Daily Cost) */
function renderGrowthCard(data, root, showToast) {
  const series = data.growth_series || [];
  const costSeries = (data.model_stability_and_cost && data.model_stability_and_cost.daily_cost_series) || [];
  const costByDate = Object.fromEntries(costSeries.map((c) => [c.date, c.cost_usd || 0]));
  const zh = getLang() === "zh";

  const enriched = series.map((d) => ({
    ...d,
    logs: (d.meal_logs || 0) + (d.workout_logs || 0),
    cost_usd: costByDate[d.date] ?? 0,
  }));

  const modeSelector = pillTabs(
    [
      ["dau", t("adm.chart.dau")],
      ["activity", t("adm.chart.activity")],
      ["cost", t("adm.chart.cost")],
    ],
    activeGrowthMode,
    (mode) => {
      activeGrowthMode = mode;
      paintAdmin(root, cachedOverview, showToast);
    },
  );

  // Inspector bar updated on hover/click
  const inspectorDate = el("strong", { class: "adm-insp-date" });
  const inspectorStats = el("div", { class: "adm-insp-stats" });
  const inspector = el("div", { class: "adm-inspector" }, [inspectorDate, inspectorStats]);

  function setInspector(day) {
    if (!day) return;
    inspectorDate.textContent = dateShort(day.date);
    inspectorStats.replaceChildren(
      el("span", { class: "adm-insp-item primary" }, [
        el("i", { class: "adm-dot-active" }),
        `DAU: `,
        el("b", { text: num(day.dau || 0) }),
      ]),
      el("span", { class: "adm-insp-item secondary" }, [
        el("i", { class: "adm-dot-new" }),
        `${zh ? "新增" : "New"}: `,
        el("b", { text: `+${num(day.new_users || 0)}` }),
      ]),
      el("span", { class: "adm-insp-item" }, [
        `${zh ? "对话" : "Turns"}: `,
        el("b", { text: num(day.turns || 0) }),
      ]),
      el("span", { class: "adm-insp-item" }, [
        `${zh ? "打卡" : "Logs"}: `,
        el("b", { text: num(day.logs || 0) }),
      ]),
      el("span", { class: "adm-insp-item" }, [
        `${zh ? "成本" : "Cost"}: `,
        el("b", { text: `$${fmtUsd(day.cost_usd || 0, 4)}` }),
      ]),
    );
  }

  // Build interactive SVG chart
  const W = 680;
  const H = 210;
  const L = 38;
  const R = 14;
  const T = 16;
  const B = 28;
  const plotW = W - L - R;
  const plotH = H - T - B;

  const primaryVal = (d) =>
    activeGrowthMode === "dau"
      ? d.dau || 0
      : activeGrowthMode === "activity"
        ? d.turns || 0
        : d.cost_usd || 0;
  const secondaryVal = (d) =>
    activeGrowthMode === "dau"
      ? d.new_users || 0
      : activeGrowthMode === "activity"
        ? d.logs || 0
        : d.turns || 0;

  const maxPrimary = Math.max(
    activeGrowthMode === "cost" ? 0.005 : 2,
    ...enriched.map(primaryVal),
  ) * 1.15;
  const maxSecondary = Math.max(2, ...enriched.map(secondaryVal)) * 1.25;

  const svg = svgEl("svg", {
    class: "chart adm-svg-chart",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": t("adm.sec.growth"),
  });

  const gradId = `admAreaGrad${++gradSeq}`;
  svg.append(
    svgEl("defs", {}, [
      svgEl("linearGradient", { id: gradId, x1: 0, x2: 0, y1: 0, y2: 1 }, [
        svgEl("stop", { offset: "0%", class: "area-stop-top" }),
        svgEl("stop", { offset: "100%", class: "area-stop-bottom" }),
      ]),
    ]),
  );

  // Horizontal grid lines & Y axis labels
  for (let i = 0; i <= 3; i++) {
    const frac = i / 3;
    const gy = T + plotH * (1 - frac);
    const val = maxPrimary * frac;
    const lbl = activeGrowthMode === "cost" ? `$${val.toFixed(3)}` : String(Math.round(val));
    svg.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: gy, y2: gy }));
    svg.append(
      svgEl("text", { class: "axis", x: L - 6, y: gy + 3, "text-anchor": "end" }, lbl),
    );
  }

  const n = Math.max(enriched.length, 1);
  const slotW = plotW / n;
  const xAt = (i) => L + slotW * (i + 0.5);
  const yPrimary = (v) => T + plotH * (1 - clamp(v / maxPrimary, 0, 1));
  const ySecondary = (v) => T + plotH * (1 - clamp(v / maxSecondary, 0, 1));

  // Secondary subtle bars
  const barElements = [];
  enriched.forEach((d, i) => {
    const sv = secondaryVal(d);
    const top = ySecondary(sv);
    const bh = Math.max(3, T + plotH - top);
    const bw = Math.min(20, slotW * 0.48);
    const rect = svgEl("rect", {
      class: "adm-svg-bar",
      x: (xAt(i) - bw / 2).toFixed(1),
      y: (T + plotH - bh).toFixed(1),
      width: bw.toFixed(1),
      height: bh.toFixed(1),
      rx: 4,
    });
    barElements.push(rect);
    svg.append(rect);
  });

  // Primary smooth area & line
  const pts = enriched.map((d, i) => [xAt(i), yPrimary(primaryVal(d))]);
  const linePath = smoothCurve(pts);
  if (pts.length > 1) {
    svg.append(
      svgEl("path", {
        class: "adm-svg-area",
        d: `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${T + plotH} L${pts[0][0].toFixed(1)},${T + plotH} Z`,
        fill: `url(#${gradId})`,
      }),
    );
  }
  svg.append(svgEl("path", { class: "adm-svg-line", d: linePath, fill: "none" }));

  // Crosshair vertical guide line
  const guideLine = svgEl("line", {
    class: "adm-svg-guide",
    x1: pts.length ? pts[pts.length - 1][0] : L,
    x2: pts.length ? pts[pts.length - 1][0] : L,
    y1: T,
    y2: T + plotH,
  });
  svg.append(guideLine);

  // Data dots + X-axis date labels + invisible interactive hit columns
  const dotElements = [];
  const labelStride = n > 16 ? 4 : n > 10 ? 2 : 1;

  function highlightIdx(idx) {
    const d = enriched[idx];
    if (!d) return;
    const cx = xAt(idx);
    guideLine.setAttribute("x1", cx.toFixed(1));
    guideLine.setAttribute("x2", cx.toFixed(1));
    dotElements.forEach((c, j) => {
      c.classList.toggle("active", j === idx);
      c.setAttribute("r", j === idx ? "5.5" : "3.2");
    });
    barElements.forEach((b, j) => b.classList.toggle("active", j === idx));
    setInspector(d);
  }

  enriched.forEach((d, i) => {
    const cx = xAt(i);
    const cy = pts[i][1];
    const dot = svgEl("circle", {
      class: "adm-svg-dot",
      cx: cx.toFixed(1),
      cy: cy.toFixed(1),
      r: i === n - 1 ? "5.5" : "3.2",
    });
    dotElements.push(dot);
    svg.append(dot);

    if (i % labelStride === 0 || i === n - 1) {
      svg.append(
        svgEl(
          "text",
          { class: "axis adm-x-lbl", x: cx.toFixed(1), y: H - 6, "text-anchor": "middle" },
          d.date.slice(5),
        ),
      );
    }

    const hit = svgEl("rect", {
      class: "adm-svg-hit",
      x: (L + slotW * i).toFixed(1),
      y: T,
      width: slotW.toFixed(1),
      height: plotH,
      fill: "transparent",
    });
    hit.addEventListener("pointerenter", () => highlightIdx(i));
    hit.addEventListener("click", () => highlightIdx(i));
    svg.append(hit);
  });

  if (enriched.length) highlightIdx(enriched.length - 1);

  const primaryLegend =
    activeGrowthMode === "dau"
      ? zh
        ? "日活用户 (DAU)"
        : "Daily Active Users (DAU)"
      : activeGrowthMode === "activity"
        ? zh
          ? "AI 教练对话轮次"
          : "AI Coach Turns"
        : zh
          ? "预估日成本 ($ USD)"
          : "Est. Daily Cost ($ USD)";
  const secondaryLegend =
    activeGrowthMode === "dau"
      ? zh
        ? "新增用户数"
        : "New Users"
      : activeGrowthMode === "activity"
        ? zh
          ? "饮食与训练打卡数"
          : "Meals & Workouts Logged"
        : zh
          ? "对话轮次"
          : "Coach Turns";

  return el("section", { class: "card adm-card adm-span-7" }, [
    el("div", { class: "card-header adm-card-header-wrap" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("trending-up", { cls: "accent" }),
          el("h2", { text: t("adm.sec.growth") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.chart.hoverHint") }),
      ]),
      modeSelector,
    ]),
    inspector,
    el("div", { class: "adm-svg-wrap" }, [svg]),
    el("div", { class: "adm-legend" }, [
      el("span", { class: "adm-legend-item" }, [el("i", { class: "adm-line-swatch" }), primaryLegend]),
      el("span", { class: "adm-legend-item" }, [el("i", { class: "adm-bar-swatch" }), secondaryLegend]),
    ]),
  ]);
}

/** Interactive 5-Stage Conversion Funnel */
function renderFunnelCard(data) {
  const funnel = data.funnel || [];
  const zh = getLang() === "zh";
  if (selectedFunnelIdx >= funnel.length) selectedFunnelIdx = 0;

  const detailBox = el("div", { class: "adm-funnel-detail" });
  const stageNodes = [];

  function selectStage(idx) {
    selectedFunnelIdx = idx;
    stageNodes.forEach((node, j) => node.classList.toggle("active", j === idx));
    const step = funnel[idx];
    if (!step) return;
    const prev = idx > 0 ? funnel[idx - 1] : null;
    const dropped = prev ? Math.max(0, (prev.count || 0) - (step.count || 0)) : 0;
    detailBox.replaceChildren(
      el("div", { class: "adm-fd-left" }, [
        el("span", { class: "adm-fd-step", text: t(`adm.funnel.${step.stage}`) }),
        el("span", {
          class: "muted small",
          text:
            idx === 0
              ? t("adm.funnel.topStage")
              : t("adm.funnel.dropoff", { n: num(dropped), pct: step.conversion_from_prev_pct }),
        }),
      ]),
      el("div", { class: "adm-fd-right" }, [
        el("strong", { class: "accent", text: `${num(step.count)} ${zh ? "人" : "users"}` }),
        el("span", { class: "pill pill-primary", text: `${step.pct_of_top}%` }),
      ]),
    );
  }

  funnel.forEach((step, idx) => {
    const w = clamp(step.pct_of_top || 0, 6, 100);
    const convText =
      idx === 0
        ? "100%"
        : `↘ ${step.conversion_from_prev_pct}%`;
    const row = el(
      "button",
      {
        type: "button",
        class: `adm-funnel-step ${idx === selectedFunnelIdx ? "active" : ""}`.trim(),
        onclick: () => selectStage(idx),
        onpointerenter: () => selectStage(idx),
      },
      [
        el("div", { class: "adm-funnel-top" }, [
          el("span", { class: "adm-funnel-name" }, [
            el("span", { class: "adm-step-num", text: String(idx + 1) }),
            el("span", { text: t(`adm.funnel.${step.stage}`).replace(/^\d+\.\s*/, "") }),
          ]),
          el("span", { class: "adm-funnel-metrics" }, [
            el("strong", { text: num(step.count) }),
            el("span", { class: "adm-conv-pill", text: convText }),
          ]),
        ]),
        el("div", { class: "adm-bar-track adm-funnel-track" }, [
          el("span", {
            class: `adm-bar-fill ${idx === funnel.length - 1 ? "tone-ok" : idx >= 2 ? "tone-secondary" : ""}`.trim(),
            style: `width:${w}%`,
          }),
        ]),
      ],
    );
    stageNodes.push(row);
  });

  if (funnel.length) selectStage(selectedFunnelIdx);

  return el("section", { class: "card adm-card adm-span-5" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("monitoring", { cls: "accent" }),
          el("h2", { text: t("adm.sec.funnel") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.funnelSub") }),
      ]),
    ]),
    el("div", { class: "adm-funnel-list" }, stageNodes),
    detailBox,
  ]);
}

/** Beta Allowlist, Waitlist & Role Management Card */
function renderAccessSection(data, root, showToast) {
  const ac = data.access_control || {};
  const entries = ac.entries || [];
  const counts = {
    all: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    approved: entries.filter((e) => e.status === "approved").length,
    revoked: entries.filter((e) => e.status === "revoked").length,
  };

  const q = accessSearchQuery.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (activeAccessFilter !== "all" && e.status !== activeAccessFilter) return false;
    if (!q) return true;
    return (
      (e.email || "").toLowerCase().includes(q) ||
      (e.given_name || "").toLowerCase().includes(q)
    );
  });

  async function mutateUser(payload) {
    try {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (showToast) {
        showToast(
          t("adm.toast.updated", {
            email: payload.email,
            status: t(`adm.status.${payload.status}`),
            role: t(`adm.role.${payload.role}`),
          }),
        );
      }
      await loadAndRenderAdmin(root, { force: true, showToast });
    } catch (err) {
      if (showToast) showToast(err.message, { iconName: "warning" });
    }
  }

  const emailInput = el("input", {
    type: "email",
    class: "text-input adm-input",
    placeholder: t("adm.emailPlaceholder"),
    required: "required",
    "aria-label": t("adm.emailPlaceholder"),
  });
  const nameInput = el("input", {
    type: "text",
    class: "text-input adm-input adm-input-sm",
    placeholder: t("adm.namePlaceholder"),
    maxlength: "60",
    "aria-label": t("adm.namePlaceholder"),
  });
  const roleSelect = el("select", { class: "text-input adm-select", "aria-label": "Role" }, [
    el("option", { value: "member", text: t("adm.role.member") }),
    el("option", { value: "admin", text: t("adm.role.admin") }),
  ]);
  const submitBtn = el("button", { type: "submit", class: "btn btn-primary btn-sm" }, [
    icon("add"),
    el("span", { text: t("adm.addBtn") }),
  ]);

  const addForm = el(
    "form",
    {
      class: "adm-add-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const email = emailInput.value.trim().toLowerCase();
        if (!email) return;
        submitBtn.disabled = true;
        await mutateUser({
          email,
          given_name: nameInput.value.trim(),
          status: "approved",
          role: roleSelect.value,
        });
        submitBtn.disabled = false;
      },
    },
    [emailInput, nameInput, roleSelect, submitBtn],
  );

  const searchInput = el("input", {
    type: "search",
    class: "text-input adm-search-input",
    placeholder: t("adm.searchPlaceholder"),
    value: accessSearchQuery,
    "aria-label": t("adm.searchPlaceholder"),
    oninput: (e) => {
      accessSearchQuery = e.target.value;
      paintAdmin(root, cachedOverview, showToast);
      const nextInput = root.querySelector(".adm-search-input");
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(accessSearchQuery.length, accessSearchQuery.length);
      }
    },
  });

  const filterTabs = pillTabs(
    [
      ["all", t("adm.filter.all", { n: counts.all }).replace(/\s*\(\d+\)/, ""), counts.all],
      ["pending", t("adm.status.pending"), counts.pending],
      ["approved", t("adm.status.approved"), counts.approved],
      ["revoked", t("adm.status.revoked"), counts.revoked],
    ],
    activeAccessFilter,
    (f) => {
      activeAccessFilter = f;
      paintAdmin(root, cachedOverview, showToast);
    },
  );

  const rows = filtered.length
    ? filtered.map((entry) => {
        const isEnvAdmin = entry.source === "env_admin";
        const statusCls = `status-${entry.status || "pending"}`;
        const roleCls = `role-${entry.role || "member"}`;
        const avatarChar = (entry.given_name || entry.email || "U").trim().charAt(0).toUpperCase();

        const actionsWrap = el("div", { class: "adm-access-actions" });
        if (isEnvAdmin) {
          actionsWrap.append(el("span", { class: "tag-muted", text: t("adm.envLock") }));
        } else {
          if (entry.status !== "approved") {
            actionsWrap.append(
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn-primary btn-xs",
                  onclick: () =>
                    mutateUser({
                      email: entry.email,
                      status: "approved",
                      role: entry.role || "member",
                      given_name: entry.given_name || "",
                    }),
                },
                [icon("check"), el("span", { text: t("adm.act.approve") })],
              ),
            );
          }
          if (entry.status === "approved") {
            const nextRole = entry.role === "admin" ? "member" : "admin";
            actionsWrap.append(
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn-secondary btn-xs",
                  onclick: () =>
                    mutateUser({
                      email: entry.email,
                      status: "approved",
                      role: nextRole,
                      given_name: entry.given_name || "",
                    }),
                },
                [
                  icon("shield"),
                  el("span", {
                    text: entry.role === "admin" ? t("adm.act.makeMember") : t("adm.act.makeAdmin"),
                  }),
                ],
              ),
            );
          }
          if (entry.status !== "revoked") {
            actionsWrap.append(
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn-outline btn-xs btn-danger-outline",
                  onclick: () =>
                    mutateUser({
                      email: entry.email,
                      status: "revoked",
                      role: "member",
                      given_name: entry.given_name || "",
                    }),
                },
                [icon("close"), el("span", { text: t("adm.act.revoke") })],
              ),
            );
          }
        }

        const timeStr = (entry.updated_at || entry.requested_at || "").slice(0, 16).replace("T", " ");
        return el("div", { class: "adm-access-row" }, [
          el("div", { class: "adm-access-left" }, [
            el("span", { class: `adm-user-avatar ${roleCls}`, text: avatarChar }),
            el("div", { class: "adm-access-info" }, [
              el("div", { class: "adm-access-main" }, [
                el("strong", { class: "adm-access-email", text: entry.email }),
                entry.given_name ? el("span", { class: "muted small", text: entry.given_name }) : null,
                el("span", { class: `adm-badge ${statusCls}`, text: t(`adm.status.${entry.status}`) }),
                el("span", { class: `adm-badge ${roleCls}`, text: t(`adm.role.${entry.role}`) }),
              ]),
              el("div", { class: "adm-access-sub muted small" }, [
                entry.lang ? el("span", { text: entry.lang.toUpperCase() }) : null,
                timeStr ? el("span", { text: ` · ${timeStr}` }) : null,
              ]),
            ]),
          ]),
          actionsWrap,
        ]);
      })
    : [el("p", { class: "adm-empty-hint muted small", text: t("adm.emptyAccess") })];

  return el("section", { class: "card adm-card adm-span-8" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("verified-user", { cls: "accent" }),
          el("h2", { text: t("adm.sec.access") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.accessSub") }),
      ]),
    ]),
    addForm,
    el("div", { class: "adm-access-toolbar" }, [filterTabs, searchInput]),
    el("div", { class: "adm-access-list" }, rows),
  ]);
}

/** Real-Time Online & Active Sessions */
function renderOnlineCard(data) {
  const users = data.online_users || [];
  return el("section", { class: "card adm-card adm-span-4" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("person", { cls: "accent" }),
          el("h2", { text: t("adm.sec.online") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.onlineSub") }),
      ]),
    ]),
    el(
      "div",
      { class: "adm-online-list" },
      users.map((u) => {
        const dotCls =
          u.status_online === "online"
            ? "is-online"
            : u.status_online === "recent"
              ? "is-recent"
              : "is-idle";
        const stateLbl =
          u.status_online === "online"
            ? t("adm.online.now")
            : u.status_online === "recent"
              ? t("adm.online.recent")
              : t("adm.online.idle");
        return el("div", { class: "adm-online-row" }, [
          el("div", { class: "adm-online-user" }, [
            el("span", { class: `adm-dot ${dotCls}`, title: stateLbl }),
            el("div", { class: "adm-online-info" }, [
              el("div", { class: "adm-access-main" }, [
                el("strong", { class: "adm-access-email", text: u.email }),
                u.role === "admin"
                  ? el("span", { class: "adm-badge role-admin", text: "ADMIN" })
                  : null,
              ]),
              el("p", {
                class: "muted small",
                text: `${u.country || "US"} · ${u.timezone || "UTC"} · ${(u.lang || "en").toUpperCase()}`,
              }),
            ]),
          ]),
          el("div", { class: "adm-online-meta" }, [
            el("span", { class: "adm-mini-tag", text: `${num(u.total_turns)} turns` }),
            el("span", { class: "muted small", text: fmtAgo(u.seconds_ago) }),
          ]),
        ]);
      }),
    ),
  ]);
}

/** Interactive Feature Usage Donut & Telemetry Switcher */
function renderFeaturesCard(data, root, showToast) {
  const fu = data.feature_usage || {};
  const dom = fu.by_domain || {};
  const intents = fu.by_intent || [];
  const tabs = fu.by_tab || [];
  const events = (fu.by_ui_event || []).slice(0, 6);

  const domItems = [
    { label: t("adm.feat.meals"), val: dom.meals_logged || 0, icon: "restaurant", cls: "seg-0" },
    { label: t("adm.feat.workouts"), val: dom.workouts_logged || 0, icon: "fitness-center", cls: "seg-1" },
    { label: t("adm.feat.weights"), val: dom.measurements_logged || 0, icon: "monitor-weight", cls: "seg-2" },
    { label: t("adm.feat.plans"), val: dom.active_plans || 0, icon: "event-note", cls: "seg-3" },
    { label: t("adm.feat.reviews"), val: dom.weekly_reviews || 0, icon: "auto-awesome", cls: "seg-4" },
    { label: t("adm.feat.confirms"), val: dom.confirmations_requested || 0, icon: "check-circle", cls: "seg-5" },
  ];
  const totalDom = Math.max(1, domItems.reduce((acc, x) => acc + x.val, 0));

  // Build interactive SVG Donut
  const r = 40;
  const c = 2 * Math.PI * r;
  const donutSvg = svgEl("svg", {
    class: "adm-donut-svg",
    viewBox: "0 0 100 100",
    width: 132,
    height: 132,
  });
  donutSvg.append(svgEl("circle", { class: "ring-track", cx: 50, cy: 50, r, fill: "none", "stroke-width": 11 }));

  const centerVal = el("span", { class: "adm-donut-val", text: num(domItems.reduce((a, b) => a + b.val, 0)) });
  const centerLbl = el("span", { class: "adm-donut-lbl", text: getLang() === "zh" ? "总记录" : "Total Logs" });
  const arcNodes = [];
  const pillNodes = [];

  function setHoverDonut(idx) {
    hoveredDonutIdx = idx;
    arcNodes.forEach((arc, j) => arc.classList.toggle("active", j === idx));
    pillNodes.forEach((p, j) => p.classList.toggle("active", j === idx));
    if (idx >= 0 && domItems[idx]) {
      const item = domItems[idx];
      const pct = Math.round((item.val / totalDom) * 100);
      centerVal.textContent = `${num(item.val)} (${pct}%)`;
      centerLbl.textContent = item.label;
    } else {
      centerVal.textContent = num(domItems.reduce((a, b) => a + b.val, 0));
      centerLbl.textContent = getLang() === "zh" ? "总功能交互" : "Domain Actions";
    }
  }

  let offset = 0;
  domItems.forEach((item, idx) => {
    const frac = item.val / totalDom;
    const len = frac * c;
    const arc = svgEl("circle", {
      class: `adm-donut-arc ${item.cls}`,
      cx: 50,
      cy: 50,
      r,
      fill: "none",
      "stroke-width": 11,
      "stroke-dasharray": `${Math.max(0, len - 1.2).toFixed(2)} ${c.toFixed(2)}`,
      "stroke-dashoffset": (-offset).toFixed(2),
      transform: "rotate(-90 50 50)",
    });
    arc.addEventListener("pointerenter", () => setHoverDonut(idx));
    arc.addEventListener("pointerleave", () => setHoverDonut(-1));
    arcNodes.push(arc);
    donutSvg.append(arc);
    offset += len;
  });

  const domLegend = el(
    "div",
    { class: "adm-dom-grid" },
    domItems.map((item, idx) => {
      const node = el(
        "button",
        {
          type: "button",
          class: `adm-dom-pill ${item.cls}`,
          onpointerenter: () => setHoverDonut(idx),
          onpointerleave: () => setHoverDonut(-1),
          onclick: () => setHoverDonut(hoveredDonutIdx === idx ? -1 : idx),
        },
        [
          el("i", { class: `adm-swatch-dot ${item.cls}` }),
          el("span", { class: "adm-dom-name", text: item.label }),
          el("strong", { text: num(item.val) }),
        ],
      );
      pillNodes.push(node);
      return node;
    }),
  );

  const subSwitch = pillTabs(
    [
      ["intents", t("adm.feat.intents")],
      ["tabs", t("adm.feat.tabs")],
      ["events", t("adm.feat.events")],
    ],
    activeFeatureTab,
    (k) => {
      activeFeatureTab = k;
      paintAdmin(root, cachedOverview, showToast);
    },
  );

  let subRows = [];
  if (activeFeatureTab === "intents") {
    subRows = intents.map((it) => barRow(it.key, `${num(it.count)} (${it.pct}%)`, it.pct));
  } else if (activeFeatureTab === "tabs") {
    const maxTab = Math.max(1, ...tabs.map((x) => x.count || 0));
    subRows = tabs.map((tb) =>
      barRow(`#${tb.tab}`, num(tb.count), Math.round((tb.count / maxTab) * 100), "tone-secondary"),
    );
  } else {
    const maxEv = Math.max(1, ...events.map((x) => x.count || 0));
    subRows = events.map((ev) =>
      barRow(ev.name, num(ev.count), Math.round((ev.count / maxEv) * 100), "tone-ok"),
    );
  }

  return el("section", { class: "card adm-card adm-span-7" }, [
    el("div", { class: "card-header adm-card-header-wrap" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("bolt", { cls: "accent" }),
          el("h2", { text: t("adm.sec.features") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.featuresSub") }),
      ]),
      subSwitch,
    ]),
    el("div", { class: "adm-feat-split" }, [
      el("div", { class: "adm-donut-col" }, [
        el("div", { class: "ring-wrap adm-donut-wrap" }, [
          donutSvg,
          el("div", { class: "ring-center", "aria-hidden": "true" }, [centerVal, centerLbl]),
        ]),
        domLegend,
      ]),
      el("div", { class: "adm-feat-bars" }, subRows),
    ]),
  ]);
}

/** Interactive Geography, Timezone & Language Card */
function renderGeoCard(data, root, showToast) {
  const geo = data.geography || {};
  const zh = getLang() === "zh";
  const countries = (geo.countries || []).slice(0, 6);
  const tzs = (geo.timezones || []).slice(0, 6);
  const langs = geo.languages || [];

  const switcher = pillTabs(
    [
      ["country", t("adm.geo.country")],
      ["tz", t("adm.geo.tz")],
      ["lang", t("adm.geo.lang")],
    ],
    activeGeoTab,
    (tab) => {
      activeGeoTab = tab;
      paintAdmin(root, cachedOverview, showToast);
    },
  );

  const listItems =
    activeGeoTab === "country"
      ? countries.map((c) =>
          barRow(
            `${c.code} · ${zh ? c.name_zh : c.name_en}`,
            `${num(c.count)} (${c.pct}%)`,
            c.pct,
          ),
        )
      : activeGeoTab === "tz"
        ? tzs.map((tz) =>
            barRow(tz.timezone, `${num(tz.count)} (${tz.pct}%)`, tz.pct, "tone-secondary"),
          )
        : langs.map((l) =>
            barRow(l.label, `${num(l.count)} (${l.pct}%)`, l.pct, "tone-ok"),
          );

  return el("section", { class: "card adm-card adm-span-5" }, [
    el("div", { class: "card-header adm-card-header-wrap" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("hub", { cls: "accent" }),
          el("h2", { text: t("adm.sec.geo") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.geoSub") }),
      ]),
      switcher,
    ]),
    el("div", { class: "adm-funnel-list" }, listItems),
    el(
      "div",
      { class: "adm-geo-chips" },
      langs.map((l) =>
        el("span", { class: "chip" }, [
          el("span", { text: l.label }),
          el("strong", { text: `${l.pct}%` }),
        ]),
      ),
    ),
  ]);
}

/** Model Call Stability & Token Cost */
function renderModelCostCard(data) {
  const mc = data.model_stability_and_cost || {};
  const total = Math.max(1, mc.total_turns || 0);

  return el("section", { class: "card adm-card adm-span-6" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("auto-awesome", { cls: "accent" }),
          el("h2", { text: t("adm.sec.model") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.modelSub") }),
      ]),
      el("span", { class: "pill pill-primary", text: `${mc.success_rate_pct ?? 100}% OK` }),
    ]),
    barRow(
      t("adm.model.budget", {
        used: fmtUsd(mc.cost_mtd_usd, 4),
        limit: fmtUsd(mc.monthly_budget_usd || 100, 2),
      }),
      `${mc.budget_used_pct || 0}%`,
      Math.max(2, mc.budget_used_pct || 0),
      (mc.budget_used_pct || 0) > 80 ? "tone-warn" : "tone-ok",
    ),
    el("div", { class: "adm-stat-strip" }, [
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: t("adm.model.inTokens") }),
        el("strong", { text: num(mc.est_input_tokens || 0) }),
      ]),
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: t("adm.model.outTokens") }),
        el("strong", { text: num(mc.est_output_tokens || 0) }),
      ]),
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: t("adm.model.avgTurn") }),
        el("strong", { class: "accent", text: `$${fmtUsd(mc.avg_cost_per_turn_usd, 4)}` }),
      ]),
    ]),
    el("div", { class: "adm-funnel-list" }, [
      barRow(t("adm.model.ok"), num(mc.ok_turns || 0), ((mc.ok_turns || 0) / total) * 100, "tone-ok"),
      barRow(
        t("adm.model.confirm"),
        num(mc.confirmation_turns || 0),
        ((mc.confirmation_turns || 0) / total) * 100,
        "tone-secondary",
      ),
      barRow(
        t("adm.model.agentErr"),
        num(mc.agent_error_turns || 0),
        ((mc.agent_error_turns || 0) / total) * 100,
        "tone-warn",
      ),
      barRow(
        t("adm.model.sysErr"),
        num(mc.system_error_turns || 0),
        ((mc.system_error_turns || 0) / total) * 100,
        "tone-warn",
      ),
    ]),
  ]);
}

/** System Stability, Latency Percentiles & Rate Limits */
function renderSystemCard(data) {
  const sys = data.system_stability || {};
  const lat = sys.latency_overall || {};
  const latByIntent = sys.latency_by_intent || [];
  const rlScopes = (sys.rate_limits && sys.rate_limits.by_scope) || [];
  const errs = (sys.errors && sys.errors.recent) || [];
  const rt = sys.runtime_info || {};
  const maxLat = Math.max(5000, lat.max_ms || 0, ...latByIntent.map((x) => x.p95_ms || 0));

  return el("section", { class: "card adm-card adm-span-6" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("deployed-code", { cls: "accent" }),
          el("h2", { text: t("adm.sec.system") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.systemSub") }),
      ]),
      el("span", {
        class: `pill ${sys.status === "healthy" ? "pill-primary" : "pill-warn"}`,
        text: t(`adm.${sys.status || "healthy"}`),
      }),
    ]),
    el("div", { class: "adm-stat-strip" }, [
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: "P50 Median" }),
        el("strong", { text: `${num(lat.p50_ms || 0)} ms` }),
      ]),
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: "P95 Tail" }),
        el("strong", { text: `${num(lat.p95_ms || 0)} ms` }),
      ]),
      el("div", { class: "adm-stat-box" }, [
        el("span", { class: "muted small", text: "Max Peak" }),
        el("strong", { text: `${num(lat.max_ms || 0)} ms` }),
      ]),
    ]),
    latByIntent.length
      ? el("div", { class: "adm-funnel-list" }, [
          el("h3", { class: "adm-subhead", text: t("adm.sys.latIntent") }),
          ...latByIntent.map((row) =>
            barRow(
              row.intent,
              `P50 ${num(row.p50_ms)} ms · P95 ${num(row.p95_ms)} ms`,
              Math.round(((row.p95_ms || 0) / maxLat) * 100),
              (row.p95_ms || 0) > 8000 ? "tone-warn" : "tone-secondary",
              `${num(row.count)} turns`,
            ),
          ),
        ])
      : null,
    el("div", { class: "adm-funnel-list" }, [
      el("h3", { class: "adm-subhead", text: t("adm.sys.rateLimits") }),
      el(
        "div",
        { class: "adm-kv-grid" },
        rlScopes.map((sc) =>
          el("div", { class: `adm-kv-row ${sc.blocked_count > 0 ? "tone-warn" : "tone-ok"}` }, [
            el("span", { class: "muted small", text: sc.scope.replace(/_/g, " ") }),
            el("strong", { text: `${num(sc.blocked_count)} / ${sc.limit_max}` }),
          ]),
        ),
      ),
    ]),
    errs.length
      ? el("div", { class: "adm-funnel-list" }, [
          el("h3", { class: "adm-subhead", text: t("adm.sys.errors") }),
          ...errs.slice(0, 3).map((er) =>
            el("div", { class: "adm-kv-row tone-warn" }, [
              el("span", { class: "adm-badge status-revoked", text: er.source }),
              el("span", { class: "muted small", text: `${er.error} · ${(er.created_at || "").slice(11, 19)}` }),
            ]),
          ),
        ])
      : null,
    el("div", { class: "card-foot" }, [
      el("span", {
        class: "muted small",
        text: `${rt.agent_backend || "local"} (${rt.agent_location || "us-east1"}) · ${rt.storage_backend || "firestore"}`,
      }),
      el("span", { class: "tag-muted", text: `v:${rt.asset_version || "dev"}` }),
    ]),
  ]);
}

/** User Feedback & CSAT Card */
function renderFeedbackCard(data) {
  const fb = data.feedback || {};
  const recent = fb.recent || [];
  const tags = fb.tags || [];

  return el("section", { class: "card adm-card adm-span-12" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("rate-review", { cls: "accent" }),
          el("h2", { text: t("adm.sec.feedback") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.feedbackSub") }),
      ]),
      el("span", { class: "pill pill-primary", text: `CSAT ${fb.satisfaction_pct ?? 100}%` }),
    ]),
    barRow(
      `👍 ${num(fb.up_count || 0)}  ·  👎 ${num(fb.down_count || 0)}  ·  💬 ${num(fb.general_count || 0)}`,
      `${num(fb.total || 0)} total`,
      fb.satisfaction_pct ?? 100,
      "tone-ok",
    ),
    tags.length
      ? el(
          "div",
          { class: "chips" },
          tags.map((tg) =>
            el("span", { class: "chip" }, [
              el("span", { text: `#${tg.tag}` }),
              el("strong", { text: num(tg.count) }),
            ]),
          ),
        )
      : null,
    recent.length
      ? el(
          "div",
          { class: "adm-fb-grid" },
          recent.slice(0, 6).map((item) =>
            el("div", { class: "adm-fb-item" }, [
              el("div", { class: "adm-fb-head" }, [
                el("span", {
                  class: `adm-badge ${item.rating === "down" ? "status-revoked" : "status-approved"}`,
                  text: item.rating === "up" ? "👍 UP" : item.rating === "down" ? "👎 DOWN" : "💬 NOTE",
                }),
                el("span", { class: "tag-muted", text: `#${item.page || "coach"}` }),
                ...(item.tags || []).map((tg) => el("span", { class: "tag-muted", text: tg })),
                el("span", {
                  class: "muted small adm-ml-auto",
                  text: (item.created_at || "").slice(0, 16).replace("T", " "),
                }),
              ]),
              item.comment ? el("p", { class: "adm-fb-msg", text: item.comment }) : null,
            ]),
          ),
        )
      : el("p", { class: "muted small", text: t("adm.fb.empty") }),
  ]);
}

function paintAdmin(root, data, showToast) {
  if (!data) return;
  const sys = data.system_stability || {};
  const s = data.summary || {};

  const rangeSwitcher = pillTabs(
    [
      [7, "7D"],
      [14, "14D"],
      [30, "30D"],
      [90, "90D"],
    ],
    currentDays,
    (d) => {
      if (currentDays === d) return;
      currentDays = d;
      loadAndRenderAdmin(root, { force: true, showToast, notify: true });
    },
  );

  const sectionTabs = pillTabs(
    [
      ["overview", t("adm.tab.overview")],
      ["analytics", t("adm.tab.analytics")],
      ["access", t("adm.tab.access"), s.waitlist_pending > 0 ? s.waitlist_pending : null],
      ["growth", t("adm.tab.growth")],
      ["ai", t("adm.tab.ai")],
    ],
    activeSectionTab,
    (tab) => {
      activeSectionTab = tab;
      paintAdmin(root, cachedOverview, showToast);
    },
    "adm-section-tabs",
  );

  const head = el("header", { class: "adm-header" }, [
    el("div", { class: "adm-header-titles" }, [
      el("div", { class: "adm-eyebrow-row" }, [
        el("span", { class: "adm-badge role-admin" }, [icon("shield"), el("span", { text: t("adm.roleBadge") })]),
        el("span", {
          class: `adm-badge ${sys.status === "healthy" ? "status-approved" : "status-pending"}`,
          text: t(`adm.${sys.status || "healthy"}`),
        }),
        lastRefreshedAt
          ? el("span", { class: "adm-badge adm-updated-badge" }, [
              el("i", { class: "adm-dot is-online" }),
              el("span", { text: t("adm.updatedAt", { time: fmtClockSec(lastRefreshedAt) }) }),
            ])
          : null,
      ]),
      el("h1", { text: t("adm.title") }),
      el("p", { class: "muted small", text: t("adm.subtitle") }),
    ]),
    el("div", { class: "adm-header-actions" }, [
      rangeSwitcher,
      el(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-sm adm-refresh-btn",
          onclick: () => loadAndRenderAdmin(root, { force: true, showToast, notify: true }),
        },
        [icon("event-repeat"), el("span", { class: "adm-refresh-label", text: t("adm.refresh") })],
      ),
    ]),
  ]);

  const kpis = renderBentoKpis(data, root, showToast);

  const panels = [];
  if (activeSectionTab === "analytics") {
    panels.push(...renderAnalyticsSection(data, () => paintAdmin(root, cachedOverview, showToast)));
  }
  if (activeSectionTab === "overview" || activeSectionTab === "growth") {
    panels.push(
      renderGrowthCard(data, root, showToast),
      renderFunnelCard(data),
    );
  }
  if (activeSectionTab === "overview" || activeSectionTab === "access") {
    panels.push(
      renderAccessSection(data, root, showToast),
      renderOnlineCard(data),
    );
  }
  if (activeSectionTab === "overview" || activeSectionTab === "growth") {
    panels.push(
      renderFeaturesCard(data, root, showToast),
      renderGeoCard(data, root, showToast),
    );
  }
  if (activeSectionTab === "overview" || activeSectionTab === "ai") {
    panels.push(
      renderModelCostCard(data),
      renderSystemCard(data),
      renderFeedbackCard(data),
    );
  }

  root.replaceChildren(
    head,
    kpis,
    sectionTabs,
    el("div", { class: "adm-bento-grid" }, panels),
  );
}

export async function loadAndRenderAdmin(root, { force = false, showToast = null, notify = false } = {}) {
  if (!root) return;
  if (cachedOverview && !force) {
    paintAdmin(root, cachedOverview, showToast);
  } else if (!cachedOverview) {
    root.replaceChildren(loadingView());
  }
  if (loading && !force) return;
  loading = true;

  const refreshBtn = root.querySelector(".adm-refresh-btn");
  if (refreshBtn) {
    refreshBtn.classList.add("is-loading");
    refreshBtn.disabled = true;
    refreshBtn.setAttribute("aria-busy", "true");
    const lbl = refreshBtn.querySelector(".adm-refresh-label");
    if (lbl) lbl.textContent = t("adm.refreshing");
  }
  if (cachedOverview && (force || notify)) {
    root.classList.add("is-refreshing");
  }

  try {
    const [fresh] = await Promise.all([
      getJson(`/api/admin/overview?days=${currentDays}`),
      notify ? new Promise((r) => setTimeout(r, 340)) : Promise.resolve(),
    ]);
    cachedOverview = fresh;
    lastRefreshedAt = new Date();
    paintAdmin(root, cachedOverview, showToast);
    if (notify) {
      root.classList.remove("just-refreshed");
      // Force reflow so rapid consecutive clicks replay the pulse animation
      void root.offsetWidth;
      root.classList.add("just-refreshed");
      setTimeout(() => root.classList.remove("just-refreshed"), 750);
      if (showToast) {
        showToast(t("adm.refreshedToast", { time: fmtClockSec(lastRefreshedAt) }));
      }
    }
  } catch (err) {
    if (cachedOverview) {
      paintAdmin(root, cachedOverview, showToast);
      if (showToast) showToast(err.message, { iconName: "warning" });
    } else {
      root.replaceChildren(
        errorView(err.message, () => loadAndRenderAdmin(root, { force: true, showToast, notify: true })),
      );
    }
  } finally {
    root.classList.remove("is-refreshing");
    loading = false;
  }
}
