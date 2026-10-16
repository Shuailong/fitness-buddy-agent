// Inline SVG charts. Colors come from CSS custom properties via classes, so
// both themes work without touching this code.
import { svgEl, fmt, shortDate, clamp, isNum } from "./util.js";

let gradientSeq = 0;

/** Calorie ring: consumed / target. */
export function calorieRing(consumed, target, { size = 128, stroke = 9, label = "" } = {}) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const pct = target ? clamp(consumed / target, 0, 1) : 0;
  const over = target && consumed > target;
  const svg = svgEl("svg", {
    class: "ring", viewBox: "0 0 100 100", width: size, height: size, role: "img",
    "aria-label": label || (target ? `${fmt(consumed)} of ${fmt(target)} kcal` : `${fmt(consumed)} kcal`),
  });
  svg.append(svgEl("circle", { class: "ring-track", cx: 50, cy: 50, r, fill: "none", "stroke-width": stroke }));
  if (pct > 0) {
    svg.append(svgEl("circle", {
      class: `ring-value${over ? " over" : ""}`, cx: 50, cy: 50, r, fill: "none", "stroke-width": stroke,
      "stroke-linecap": "round", "stroke-dasharray": `${(c * pct).toFixed(2)} ${c.toFixed(2)}`,
      transform: "rotate(-90 50 50)",
    }));
  }
  return svg;
}

/** Small progress ring (e.g. sessions done / planned). */
export function miniRing(value, max, { size = 88, stroke = 10, label = "" } = {}) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const pct = max ? clamp(value / max, 0, 1) : 0;
  const svg = svgEl("svg", { class: "ring", viewBox: "0 0 100 100", width: size, height: size, role: "img", "aria-label": label });
  svg.append(svgEl("circle", { class: "ring-track", cx: 50, cy: 50, r, fill: "none", "stroke-width": stroke }));
  if (pct > 0) {
    svg.append(svgEl("circle", {
      class: "ring-value", cx: 50, cy: 50, r, fill: "none", "stroke-width": stroke, "stroke-linecap": "round",
      "stroke-dasharray": `${(c * pct).toFixed(2)} ${c.toFixed(2)}`, transform: "rotate(-90 50 50)",
    }));
  }
  return svg;
}

function smoothPath(pts) {
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

/** Weight chart: dots = daily weigh-ins, smooth line + area = 7-day moving average. */
export function weightChart(points, { width = 340, height = 190, compact = false } = {}) {
  const W = width, H = height, L = compact ? 6 : 30, R = 10, T = 12, B = compact ? 8 : 26;
  const svg = svgEl("svg", {
    class: "chart weight-chart", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": points.length
      ? `Weight trend from ${shortDate(points[0].local_date)} (${fmt(points[0].weight_kg, 1)} kg) to ${shortDate(points[points.length - 1].local_date)} (${fmt(points[points.length - 1].weight_kg, 1)} kg)`
      : "Weight trend chart",
  });
  if (!points.length) return svg;
  const t0 = Date.parse(points[0].local_date);
  const t1 = Date.parse(points[points.length - 1].local_date);
  const span = Math.max(1, t1 - t0);
  const vals = points.flatMap((p) => [p.weight_kg, p.moving_average_kg]).filter(isNum);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1.5) { const mid = (max + min) / 2; min = mid - 0.75; max = mid + 0.75; }
  const pad = (max - min) * 0.12; min -= pad; max += pad;
  const step = [0.2, 0.5, 1, 2, 5, 10].find((s) => (max - min) / s <= 4) || 10;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const x = (p) => (points.length === 1 ? (L + W - R) / 2 : L + ((Date.parse(p.local_date) - t0) * (W - L - R)) / span);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);

  if (!compact) {
    for (let v = min; v <= max + step / 2; v += step) {
      svg.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.append(svgEl("text", { class: "axis", x: L - 6, y: y(v) + 3, "text-anchor": "end" }, v.toFixed(step < 1 ? 1 : 0)));
    }
  }
  const id = `wgrad${++gradientSeq}`;
  svg.append(svgEl("defs", {}, [svgEl("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 }, [
    svgEl("stop", { offset: "0%", class: "area-stop-top" }),
    svgEl("stop", { offset: "100%", class: "area-stop-bottom" }),
  ])]));
  const ma = points.map((p) => [x(p), y(p.moving_average_kg)]);
  const line = smoothPath(ma);
  if (points.length > 1) {
    svg.append(svgEl("path", { class: "area", d: `${line} L${ma[ma.length - 1][0].toFixed(1)},${H - B} L${ma[0][0].toFixed(1)},${H - B} Z`, fill: `url(#${id})` }));
  }
  points.forEach((p) => svg.append(svgEl("circle", { class: "dot", cx: x(p), cy: y(p.weight_kg), r: compact ? 2 : 3 },
    [svgEl("title", {}, `${shortDate(p.local_date)}: ${fmt(p.weight_kg, 1)} kg (7-day avg ${fmt(p.moving_average_kg, 1)} kg)`)])));
  svg.append(svgEl("path", { class: "line", d: line, fill: "none" }));
  const last = ma[ma.length - 1];
  svg.append(svgEl("circle", { class: "end-dot", cx: last[0], cy: last[1], r: 4.5 }));
  return svg;
}

/** 14-day calories bars with a dashed target line; over-target bars use the warning color. */
export function calorieBars(days, target, { width = 340, height = 150 } = {}) {
  const W = width, H = height, T = 18, B = 6;
  const label = target ? `Daily calories for the last ${days.length} days versus a ${fmt(target)} kcal target` : `Daily calories for the last ${days.length} days`;
  const svg = svgEl("svg", { class: "chart kcal-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  const max = Math.max(target || 0, ...days.map((d) => d.calories_kcal || 0), 500) * 1.08;
  const slot = W / days.length;
  const y = (v) => T + ((max - v) * (H - T - B)) / max;
  days.forEach((d, i) => {
    const isToday = i === days.length - 1;
    const logged = d.meals_logged > 0;
    const over = logged && d.target_calories_kcal && d.calories_kcal > d.target_calories_kcal;
    const value = logged ? d.calories_kcal : max * 0.04;
    const top = y(value);
    const cls = !logged ? "bar empty" : over ? "bar over" : isToday ? "bar today" : "bar";
    svg.append(svgEl("rect", {
      class: cls, x: i * slot + slot * 0.14, y: top, width: slot * 0.72, height: Math.max(2, H - B - top), rx: 3,
    }, [svgEl("title", {}, logged ? `${shortDate(d.local_date)}: ${fmt(d.calories_kcal)} kcal` : `${shortDate(d.local_date)}: nothing logged`)]));
  });
  if (target) {
    svg.append(svgEl("line", { class: "target-line", x1: 0, x2: W, y1: y(target), y2: y(target) }));
    svg.append(svgEl("text", { class: "axis target-label", x: W - 2, y: y(target) - 5, "text-anchor": "end" }, `${fmt(target)} kcal`));
  }
  return svg;
}
