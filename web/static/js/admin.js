// Admin Console view (#admin): role-gated operational dashboard & beta allowlist manager.
import { el, icon } from "./util.js";
import { api, getJson } from "./api.js";
import { t, getLang, num } from "./i18n.js";
import { loadingView, errorView } from "./views.js";

let cachedOverview = null;
let activeFilter = "all";
let loading = false;

function fmtUsd(val, digits = 4) {
  const n = Number(val) || 0;
  return n.toFixed(digits);
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

function kpiCard(label, valueNode, subText, iconName, accentCls = "") {
  return el("div", { class: `card adm-kpi ${accentCls}`.trim() }, [
    el("div", { class: "adm-kpi-top" }, [
      el("span", { class: "adm-kpi-label", text: label }),
      el("span", { class: "adm-kpi-icon" }, [icon(iconName)]),
    ]),
    el("div", { class: "adm-kpi-val" }, [valueNode]),
    el("p", { class: "adm-kpi-sub muted small", text: subText }),
  ]);
}

function barRow(label, rightText, pct, tone = "") {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return el("div", { class: "adm-bar-row" }, [
    el("div", { class: "adm-bar-meta" }, [
      el("span", { class: "adm-bar-label", text: label }),
      el("span", { class: "adm-bar-val", text: rightText }),
    ]),
    el("div", { class: "bar-track adm-track" }, [
      el("span", { class: tone, style: `width:${w}%` }),
    ]),
  ]);
}

/** 1. Beta Allowlist, Waitlist & Role Management Card */
function renderAccessSection(data, root, showToast) {
  const ac = data.access_control || {};
  const entries = ac.entries || [];
  const counts = {
    all: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    approved: entries.filter((e) => e.status === "approved").length,
    revoked: entries.filter((e) => e.status === "revoked").length,
  };
  const filtered = activeFilter === "all" ? entries : entries.filter((e) => e.status === activeFilter);

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

  const filterBar = el(
    "div",
    { class: "adm-filters" },
    ["all", "pending", "approved", "revoked"].map((f) =>
      el(
        "button",
        {
          type: "button",
          class: `adm-filter-btn ${activeFilter === f ? "active" : ""}`.trim(),
          onclick: () => {
            activeFilter = f;
            paintAdmin(root, cachedOverview, showToast);
          },
        },
        [t(`adm.filter.${f}`, { n: counts[f] })],
      ),
    ),
  );

  const rows = filtered.map((entry) => {
    const isEnvAdmin = entry.source === "env_admin";
    const statusCls =
      entry.status === "approved"
        ? "adm-badge-ok"
        : entry.status === "pending"
          ? "adm-badge-warn"
          : "adm-badge-muted";
    const roleCls = entry.role === "admin" ? "adm-badge-admin" : "adm-badge-member";

    const actionsWrap = el("div", { class: "adm-row-actions" });
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
              class: "btn btn-outline btn-xs adm-btn-danger",
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
      el("div", { class: "adm-user-main" }, [
        el("div", { class: "adm-user-line" }, [
          el("strong", { class: "adm-email", text: entry.email }),
          entry.given_name ? el("span", { class: "muted small", text: `(${entry.given_name})` }) : null,
        ]),
        el("div", { class: "adm-badges" }, [
          el("span", { class: `adm-badge ${statusCls}`, text: t(`adm.status.${entry.status}`) }),
          el("span", { class: `adm-badge ${roleCls}`, text: t(`adm.role.${entry.role}`) }),
          entry.lang ? el("span", { class: "tag-muted", text: entry.lang.toUpperCase() }) : null,
          timeStr ? el("span", { class: "muted small", text: timeStr }) : null,
        ]),
      ]),
      actionsWrap,
    ]);
  });

  return el("section", { class: "card adm-card adm-span-full" }, [
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
    filterBar,
    el("div", { class: "adm-access-list" }, rows),
  ]);
}

/** 2A. 14-Day User Growth & Activity Chart */
function renderGrowthCard(data) {
  const series = data.growth_series || [];
  const maxDau = Math.max(1, ...series.map((d) => d.dau || 0));
  const maxTurns = Math.max(1, ...series.map((d) => (d.turns || 0) + (d.meal_logs || 0) + (d.workout_logs || 0)));
  const zh = getLang() === "zh";

  const bars = series.map((item) => {
    const dauH = Math.max(6, Math.round(((item.dau || 0) / maxDau) * 76));
    const actCount = (item.turns || 0) + (item.meal_logs || 0) + (item.workout_logs || 0);
    const turnH = Math.max(4, Math.round((actCount / maxTurns) * 76));
    const tip = `${item.date}: DAU ${item.dau}, ${zh ? "新增" : "New"} ${item.new_users}, ${zh ? "对话" : "Turns"} ${item.turns}, ${zh ? "记录" : "Logs"} ${(item.meal_logs || 0) + (item.workout_logs || 0)}`;
    return el("div", { class: "adm-day-col", title: tip }, [
      el("div", { class: "adm-day-bars" }, [
        el("span", { class: "adm-b-dau", style: `height:${dauH}px` }),
        el("span", { class: "adm-b-turn", style: `height:${turnH}px` }),
      ]),
      el("span", { class: "adm-day-lbl", text: item.date.slice(5) }),
    ]);
  });

  return el("section", { class: "card adm-card" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("trending-up", { cls: "accent" }),
          el("h2", { text: t("adm.sec.growth") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.growthSub") }),
      ]),
    ]),
    el("div", { class: "adm-chart-wrap" }, bars),
    el("div", { class: "legend adm-legend" }, [
      el("span", {}, [el("i", { class: "adm-swatch dau" }), zh ? "日活用户 (DAU)" : "Daily Active Users (DAU)"]),
      el("span", {}, [el("i", { class: "adm-swatch turn" }), zh ? "教练对话 & 打卡" : "Coach Turns & Logs"]),
    ]),
  ]);
}

/** 2B. 5-Stage Conversion Funnel */
function renderFunnelCard(data) {
  const funnel = data.funnel || [];
  return el("section", { class: "card adm-card" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("monitoring", { cls: "accent" }),
          el("h2", { text: t("adm.sec.funnel") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.funnelSub") }),
      ]),
    ]),
    el(
      "div",
      { class: "adm-funnel-list" },
      funnel.map((step, idx) =>
        barRow(
          t(`adm.funnel.${step.stage}`),
          `${num(step.count)} (${step.pct_of_top}% · ${idx === 0 ? "100%" : t("adm.funnel.conv", { pct: step.conversion_from_prev_pct })})`,
          step.pct_of_top,
          idx === funnel.length - 1 ? "adm-tone-ok" : "",
        ),
      ),
    ),
  ]);
}

/** 2C. Real-Time Online & Active Sessions */
function renderOnlineCard(data) {
  const users = data.online_users || [];
  return el("section", { class: "card adm-card" }, [
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
      { class: "adm-table-wrap" },
      users.map((u) => {
        const dotCls =
          u.status_online === "online"
            ? "adm-dot-online"
            : u.status_online === "recent"
              ? "adm-dot-recent"
              : "adm-dot-idle";
        const stateLbl =
          u.status_online === "online"
            ? t("adm.online.now")
            : u.status_online === "recent"
              ? t("adm.online.recent")
              : t("adm.online.idle");
        return el("div", { class: "adm-online-row" }, [
          el("div", { class: "adm-online-left" }, [
            el("span", { class: `adm-dot ${dotCls}`, title: stateLbl }),
            el("div", {}, [
              el("div", { class: "adm-user-line" }, [
                el("strong", { text: u.email }),
                u.role === "admin"
                  ? el("span", { class: "adm-badge adm-badge-admin", text: "ADMIN" })
                  : null,
              ]),
              el("p", {
                class: "muted small",
                text: `${u.country || "US"} · ${u.timezone || "UTC"} · ${(u.lang || "en").toUpperCase()}`,
              }),
            ]),
          ]),
          el("div", { class: "adm-online-right" }, [
            el("span", { class: "pill pill-outline", text: `${num(u.total_turns)} turns` }),
            el("span", { class: "muted small", text: fmtAgo(u.seconds_ago) }),
          ]),
        ]);
      }),
    ),
  ]);
}

/** 2D. Geography, Timezone & Language */
function renderGeoCard(data) {
  const geo = data.geography || {};
  const zh = getLang() === "zh";
  const countries = (geo.countries || []).slice(0, 6);
  const tzs = (geo.timezones || []).slice(0, 5);
  const langs = geo.languages || [];

  return el("section", { class: "card adm-card" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("hub", { cls: "accent" }),
          el("h2", { text: t("adm.sec.geo") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.geoSub") }),
      ]),
    ]),
    el("div", { class: "adm-subgrid" }, [
      el("div", {}, [
        el("h3", { class: "eyebrow", text: t("adm.geo.country") }),
        el(
          "div",
          { class: "adm-stack-sm" },
          countries.map((c) =>
            barRow(
              `${c.code} · ${zh ? c.name_zh : c.name_en}`,
              `${c.count} (${c.pct}%)`,
              c.pct,
            ),
          ),
        ),
      ]),
      el("div", {}, [
        el("h3", { class: "eyebrow", text: t("adm.geo.tz") }),
        el(
          "div",
          { class: "adm-stack-sm" },
          tzs.map((tz) => barRow(tz.timezone, `${tz.count} (${tz.pct}%)`, tz.pct, "adm-tone-sec")),
        ),
        el("h3", { class: "eyebrow adm-mt", text: t("adm.geo.lang") }),
        el(
          "div",
          { class: "adm-stack-sm" },
          langs.map((l) => barRow(l.label, `${l.count} (${l.pct}%)`, l.pct, "adm-tone-ok")),
        ),
      ]),
    ]),
  ]);
}

/** 2E. Feature Usage & Telemetry */
function renderFeaturesCard(data) {
  const fu = data.feature_usage || {};
  const dom = fu.by_domain || {};
  const intents = fu.by_intent || [];
  const tabs = fu.by_tab || [];
  const events = (fu.by_ui_event || []).slice(0, 6);
  const maxTab = Math.max(1, ...tabs.map((x) => x.count || 0));

  const domItems = [
    [t("adm.feat.meals"), dom.meals_logged || 0, "restaurant"],
    [t("adm.feat.workouts"), dom.workouts_logged || 0, "fitness-center"],
    [t("adm.feat.weights"), dom.measurements_logged || 0, "monitor-weight"],
    [t("adm.feat.plans"), dom.active_plans || 0, "event-note"],
    [t("adm.feat.reviews"), dom.weekly_reviews || 0, "auto-awesome"],
    [t("adm.feat.confirms"), dom.confirmations_requested || 0, "check-circle"],
  ];

  return el("section", { class: "card adm-card" }, [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("div", { class: "card-heading" }, [
          icon("bolt", { cls: "accent" }),
          el("h2", { text: t("adm.sec.features") }),
        ]),
        el("p", { class: "muted small adm-card-sub", text: t("adm.sec.featuresSub") }),
      ]),
    ]),
    el(
      "div",
      { class: "adm-mini-grid" },
      domItems.map(([lbl, val, ic]) =>
        el("div", { class: "adm-mini-stat" }, [
          icon(ic, { cls: "accent" }),
          el("strong", { text: num(val) }),
          el("span", { class: "muted small", text: lbl }),
        ]),
      ),
    ),
    el("div", { class: "adm-subgrid adm-mt" }, [
      el("div", {}, [
        el("h3", { class: "eyebrow", text: t("adm.feat.intents") }),
        el(
          "div",
          { class: "adm-stack-sm" },
          intents.map((it) => barRow(it.key, `${num(it.count)} (${it.pct}%)`, it.pct)),
        ),
      ]),
      el("div", {}, [
        el("h3", { class: "eyebrow", text: t("adm.feat.tabs") }),
        el(
          "div",
          { class: "adm-stack-sm" },
          tabs.map((tb) =>
            barRow(`#${tb.tab}`, num(tb.count), Math.round((tb.count / maxTab) * 100), "adm-tone-sec"),
          ),
        ),
      ]),
    ]),
    events.length
      ? el("div", { class: "adm-mt" }, [
          el("h3", { class: "eyebrow", text: t("adm.feat.events") }),
          el(
            "div",
            { class: "chips" },
            events.map((ev) =>
              el("span", { class: "chip" }, [
                el("span", { text: ev.name }),
                el("strong", { text: num(ev.count) }),
              ]),
            ),
          ),
        ])
      : null,
  ]);
}

/** 2F. User Feedback & CSAT */
function renderFeedbackCard(data) {
  const fb = data.feedback || {};
  const recent = fb.recent || [];
  const tags = fb.tags || [];

  return el("section", { class: "card adm-card" }, [
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
      `👍 ${num(fb.up_count || 0)} · 👎 ${num(fb.down_count || 0)} · 💬 ${num(fb.general_count || 0)}`,
      `${num(fb.total || 0)} total`,
      fb.satisfaction_pct ?? 100,
      "adm-tone-ok",
    ),
    tags.length
      ? el(
          "div",
          { class: "chips adm-mt" },
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
          { class: "adm-fb-list adm-mt" },
          recent.slice(0, 6).map((item) =>
            el("div", { class: "adm-fb-item" }, [
              el("div", { class: "adm-fb-head" }, [
                el("span", {
                  class: `adm-badge ${item.rating === "down" ? "adm-badge-warn" : "adm-badge-ok"}`,
                  text: item.rating === "up" ? "👍 UP" : item.rating === "down" ? "👎 DOWN" : "💬 NOTE",
                }),
                el("span", { class: "tag-muted", text: `#${item.page || "coach"}` }),
                ...(item.tags || []).map((tg) => el("span", { class: "tag-muted", text: tg })),
                el("span", { class: "muted small adm-ml-auto", text: (item.created_at || "").slice(0, 16).replace("T", " ") }),
              ]),
              item.comment ? el("p", { class: "adm-fb-comment", text: item.comment }) : null,
            ]),
          ),
        )
      : el("p", { class: "muted small adm-mt", text: t("adm.fb.empty") }),
  ]);
}

/** 3A. Model Call Stability & Cost */
function renderModelCostCard(data) {
  const mc = data.model_stability_and_cost || {};
  const total = Math.max(1, mc.total_turns || 0);

  return el("section", { class: "card adm-card" }, [
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
      (mc.budget_used_pct || 0) > 80 ? "adm-tone-warn" : "adm-tone-ok",
    ),
    el("div", { class: "adm-mini-grid adm-mt" }, [
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: num(mc.est_input_tokens || 0) }),
        el("span", { class: "muted small", text: t("adm.model.inTokens") }),
      ]),
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: num(mc.est_output_tokens || 0) }),
        el("span", { class: "muted small", text: t("adm.model.outTokens") }),
      ]),
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: `$${fmtUsd(mc.avg_cost_per_turn_usd, 4)}` }),
        el("span", { class: "muted small", text: t("adm.model.avgTurn") }),
      ]),
    ]),
    el("div", { class: "adm-stack-sm adm-mt" }, [
      barRow(t("adm.model.ok"), num(mc.ok_turns || 0), ((mc.ok_turns || 0) / total) * 100, "adm-tone-ok"),
      barRow(
        t("adm.model.confirm"),
        num(mc.confirmation_turns || 0),
        ((mc.confirmation_turns || 0) / total) * 100,
        "adm-tone-sec",
      ),
      barRow(
        t("adm.model.agentErr"),
        num(mc.agent_error_turns || 0),
        ((mc.agent_error_turns || 0) / total) * 100,
        "adm-tone-warn",
      ),
      barRow(
        t("adm.model.sysErr"),
        num(mc.system_error_turns || 0),
        ((mc.system_error_turns || 0) / total) * 100,
        "adm-tone-warn",
      ),
    ]),
  ]);
}

/** 3B. System Stability, Latency & Rate Limits */
function renderSystemCard(data) {
  const sys = data.system_stability || {};
  const lat = sys.latency_overall || {};
  const latByIntent = sys.latency_by_intent || [];
  const rlScopes = (sys.rate_limits && sys.rate_limits.by_scope) || [];
  const errs = (sys.errors && sys.errors.recent) || [];
  const rt = sys.runtime_info || {};

  return el("section", { class: "card adm-card" }, [
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
    el("div", { class: "adm-mini-grid" }, [
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: `${num(lat.p50_ms || 0)} ms` }),
        el("span", { class: "muted small", text: "P50 Latency" }),
      ]),
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: `${num(lat.p95_ms || 0)} ms` }),
        el("span", { class: "muted small", text: "P95 Latency" }),
      ]),
      el("div", { class: "adm-mini-stat" }, [
        el("strong", { text: `${num(lat.max_ms || 0)} ms` }),
        el("span", { class: "muted small", text: "Max Latency" }),
      ]),
    ]),
    latByIntent.length
      ? el("div", { class: "adm-mt" }, [
          el("h3", { class: "eyebrow", text: t("adm.sys.latIntent") }),
          el(
            "div",
            { class: "adm-stack-sm" },
            latByIntent.map((row) =>
              el("div", { class: "adm-kv-row" }, [
                el("strong", { text: row.intent }),
                el("span", {
                  class: "muted small",
                  text: `${row.count} turns · P50 ${num(row.p50_ms)} ms · P95 ${num(row.p95_ms)} ms`,
                }),
              ]),
            ),
          ),
        ])
      : null,
    el("div", { class: "adm-mt" }, [
      el("h3", { class: "eyebrow", text: t("adm.sys.rateLimits") }),
      el(
        "div",
        { class: "adm-stack-sm" },
        rlScopes.map((sc) =>
          el("div", { class: "adm-kv-row" }, [
            el("span", { text: sc.scope }),
            el("span", {
              class: sc.blocked_count > 0 ? "adm-badge adm-badge-warn" : "tag-muted",
              text: `${num(sc.blocked_count)} blocked (max ${sc.limit_max}/${sc.window_seconds}s)`,
            }),
          ]),
        ),
      ),
    ]),
    el("div", { class: "adm-mt" }, [
      el("h3", { class: "eyebrow", text: t("adm.sys.errors") }),
      errs.length
        ? el(
            "div",
            { class: "adm-stack-sm" },
            errs.slice(0, 5).map((er) =>
              el("div", { class: "adm-kv-row" }, [
                el("span", { class: "adm-badge adm-badge-warn", text: er.source }),
                el("span", { class: "muted small", text: `${er.error} · ${(er.created_at || "").slice(11, 19)}` }),
              ]),
            ),
          )
        : el("p", { class: "muted small", text: t("adm.sys.noErrors") }),
    ]),
    el("div", { class: "card-foot" }, [
      el("span", {
        class: "muted small",
        text: `Backend: ${rt.agent_backend || "local"} (${rt.agent_location || "us-east1"}) · Storage: ${rt.storage_backend || "firestore"}`,
      }),
      el("span", { class: "tag-muted", text: `v:${rt.asset_version || "dev"}` }),
    ]),
  ]);
}

function paintAdmin(root, data, showToast) {
  if (!data) return;
  const s = data.summary || {};
  const mc = data.model_stability_and_cost || {};
  const sys = data.system_stability || {};
  const lat = sys.latency_overall || {};
  const fb = data.feedback || {};

  const head = el("header", { class: "adm-header" }, [
    el("div", {}, [
      el("div", { class: "adm-title-row" }, [
        el("h1", { text: t("adm.title") }),
        el("span", { class: "pill pill-primary", text: t("adm.roleBadge") }),
        el("span", {
          class: `pill ${sys.status === "healthy" ? "pill-outline" : "pill-warn"}`,
          text: t(`adm.${sys.status || "healthy"}`),
        }),
      ]),
      el("p", { class: "muted", text: t("adm.subtitle") }),
    ]),
    el(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-sm",
        onclick: () => loadAndRenderAdmin(root, { force: true, showToast }),
      },
      [icon("event-repeat"), el("span", { text: t("adm.refresh") })],
    ),
  ]);

  const kpis = el("div", { class: "adm-kpi-grid" }, [
    kpiCard(
      t("adm.kpi.online"),
      el("span", { class: "adm-online-num" }, [
        el("i", { class: "adm-dot adm-dot-online" }),
        el("span", { text: num(s.online_now_5m || 0) }),
      ]),
      t("adm.kpi.onlineSub", { n: num(s.active_15m || 0) }),
      "person",
      "adm-kpi-highlight",
    ),
    kpiCard(
      t("adm.kpi.active"),
      el("span", { text: `${num(s.dau || 0)} / ${num(s.wau || 0)} / ${num(s.mau || 0)}` }),
      t("adm.kpi.activeSub", { pct: s.stickiness_pct ?? 0 }),
      "trending-up",
    ),
    kpiCard(
      t("adm.kpi.users"),
      el("span", { text: num(s.total_users || 0) }),
      t("adm.kpi.usersSub", {
        p: num(s.profiled_users || 0),
        d1: s.d1_retention_pct ?? 0,
        d7: s.d7_retention_pct ?? 0,
      }),
      "verified-user",
    ),
    kpiCard(
      t("adm.kpi.waitlist"),
      el("span", { text: num(s.waitlist_pending || 0) }),
      t("adm.kpi.waitlistSub", {
        a: num(s.waitlist_approved || 0),
        p: num(s.waitlist_pending || 0),
      }),
      "shield",
      s.waitlist_pending > 0 ? "adm-kpi-warn" : "",
    ),
    kpiCard(
      t("adm.kpi.modelOk"),
      el("span", { text: `${mc.success_rate_pct ?? 100}%` }),
      t("adm.kpi.modelOkSub", {
        turns: num(mc.total_turns || 0),
        photos: num(mc.photo_turns || 0),
      }),
      "auto-awesome",
    ),
    kpiCard(
      t("adm.kpi.cost"),
      el("span", { text: `$${fmtUsd(mc.cost_mtd_usd, 4)}` }),
      t("adm.kpi.costSub", {
        today: fmtUsd(mc.cost_today_usd, 4),
        budget: fmtUsd(mc.monthly_budget_usd || 100, 0),
      }),
      "bolt",
    ),
    kpiCard(
      t("adm.kpi.latency"),
      el("span", { text: `${num(lat.p50_ms || 0)} / ${num(lat.p95_ms || 0)} ms` }),
      t("adm.kpi.latencySub", {
        avg: num(lat.avg_ms || 0),
        max: num(lat.max_ms || 0),
      }),
      "timer",
    ),
    kpiCard(
      t("adm.kpi.csat"),
      el("span", { text: `${fb.satisfaction_pct ?? 100}%` }),
      t("adm.kpi.csatSub", {
        up: num(fb.up_count || 0),
        down: num(fb.down_count || 0),
        upPct: sys.uptime_pct ?? 100,
      }),
      "thumb-up",
    ),
  ]);

  const grid = el("div", { class: "adm-grid" }, [
    renderAccessSection(data, root, showToast),
    renderGrowthCard(data),
    renderFunnelCard(data),
    renderOnlineCard(data),
    renderGeoCard(data),
    renderFeaturesCard(data),
    renderFeedbackCard(data),
    renderModelCostCard(data),
    renderSystemCard(data),
  ]);

  root.replaceChildren(head, kpis, grid);
}

export async function loadAndRenderAdmin(root, { force = false, showToast = null } = {}) {
  if (!root) return;
  if (cachedOverview && !force) {
    paintAdmin(root, cachedOverview, showToast);
  } else if (!cachedOverview) {
    root.replaceChildren(loadingView());
  }
  if (loading && !force) return;
  loading = true;
  try {
    cachedOverview = await getJson("/api/admin/overview?days=14");
    paintAdmin(root, cachedOverview, showToast);
  } catch (err) {
    root.replaceChildren(errorView(err.message, () => loadAndRenderAdmin(root, { force: true, showToast })));
  } finally {
    loading = false;
  }
}
