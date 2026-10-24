// Stick-figure poses for the exercise demo animation, one per movement
// pattern (see web/exercise_guides.py PATTERNS). Side view facing right,
// viewBox 0 0 360 210, floor at y = 186.
//
// computePose(pattern, t) returns joint coordinates for phase t in [0, 1]:
// - "rep" / "stretch" patterns: t = 0 is the start position, t = 1 the other
//   end of the movement (the renderer drives 0 -> 1 -> 0).
// - "cyclic" patterns (cardio): t is the position in the stride/stroke cycle
//   (0..1 wraps around).
// - "hold" patterns: t only adds a subtle breathing sway.

const THIGH = 44;
const SHIN = 42;
const TORSO = 50;
const NECK = 19;
const UARM = 28;
const FARM = 26;
const FOOT = 15;

const rad = (d) => (d * Math.PI) / 180;
const P = (p, deg, len) => [p[0] + len * Math.cos(rad(deg)), p[1] + len * Math.sin(rad(deg))];
const add = (p, d) => [p[0] + d[0], p[1] + d[1]];
const mix = (a, b, t) => a + (b - a) * t;
const mixPt = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];

/** Two-link inverse kinematics: joint between `root` and `target`. */
function ik(root, target, a, b, bend) {
  const dx = target[0] - root[0];
  const dy = target[1] - root[1];
  const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(a - b) + 0.01), a + b - 0.01);
  const base = Math.atan2(dy, dx);
  const off = Math.acos((a * a + d * d - b * b) / (2 * a * d));
  const ang = base + bend * off;
  return [root[0] + a * Math.cos(ang), root[1] + a * Math.sin(ang)];
}

/** Interpolates every numeric / point field of two pose specs. */
function lerpSpec(a, b, t) {
  const ka = Object.keys(a).filter((k) => typeof a[k] !== "number" || !Number.isInteger(a[k]) || Math.abs(a[k]) !== 1).sort().join();
  const kb = Object.keys(b).filter((k) => typeof b[k] !== "number" || !Number.isInteger(b[k]) || Math.abs(b[k]) !== 1).sort().join();
  if (ka !== kb && typeof console !== "undefined") console.warn("pose spec keys differ", ka, "|", kb);
  const out = {};
  for (const k of Object.keys(a)) {
    const va = a[k];
    const vb = k in b ? b[k] : va;
    if (typeof va === "number") out[k] = mix(va, vb, t);
    else if (Array.isArray(va) && typeof va[0] === "number") out[k] = mixPt(va, vb, t);
    else out[k] = va;
  }
  for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
  return out;
}

/**
 * Builds joints from a compact spec:
 *   hip [x,y] | ankle [x,y] (+ thigh/shin angles to place the hip)
 *   torso (deg, hip -> shoulder), head (deg, optional)
 *   leg: foot target `ankle` with `knee` bend (+1/-1) or `thigh`/`shin` angles
 *   arm: `hand` target (absolute) or `handRel` (from shoulder) with `elbow`
 *        bend, or `uarm`/`farm` angles
 *   back leg / back arm: `bAnkle`/`bKnee` bend or `bThigh`/`bShin`;
 *   `bHand`/`bHandRel`/`bElbow` or `bUarm`/`bFarm`
 */
function build(s) {
  let hip = s.hip;
  let knee;
  let ankle = s.ankle;
  if (!hip) {
    // Anchor at the ankle and walk up the leg.
    knee = P(ankle, s.shin + 180, SHIN);
    hip = P(knee, s.thigh + 180, THIGH);
  } else if (ankle) {
    knee = ik(hip, ankle, THIGH, SHIN, s.knee ?? -1);
  } else {
    knee = P(hip, s.thigh, THIGH);
    ankle = P(knee, s.shin, SHIN);
  }
  const shoulder = s.shoulder || P(hip, s.torso, TORSO);
  const head = P(shoulder, s.head ?? s.torso ?? -90, NECK);
  let hand = s.hand || (s.handRel && add(shoulder, s.handRel));
  let elbow;
  if (hand) elbow = ik(shoulder, hand, UARM, FARM, s.elbow ?? 1);
  else {
    elbow = P(shoulder, s.uarm ?? 90, UARM);
    hand = P(elbow, s.farm ?? 90, FARM);
  }
  const pose = {
    head, shoulder, hip, knee, ankle, elbow, hand,
    foot: P(ankle, s.footDir ?? 0, FOOT),
  };
  if (s.bAnkle) {
    pose.backKnee = ik(hip, s.bAnkle, THIGH, SHIN, s.bKnee ?? -1);
    pose.backAnkle = s.bAnkle;
  } else if (s.bThigh !== undefined) {
    pose.backKnee = P(hip, s.bThigh, THIGH);
    pose.backAnkle = P(pose.backKnee, s.bShin, SHIN);
  }
  if (pose.backAnkle) pose.backFoot = P(pose.backAnkle, s.bFootDir ?? s.footDir ?? 0, FOOT);
  const bHand = s.bHand || (s.bHandRel && add(shoulder, s.bHandRel));
  if (bHand) {
    pose.backElbow = ik(shoulder, bHand, UARM, FARM, s.bElbow ?? 1);
    pose.backHand = bHand;
  } else if (s.bUarm !== undefined) {
    pose.backElbow = P(shoulder, s.bUarm, UARM);
    pose.backHand = P(pose.backElbow, s.bFarm, FARM);
  }
  if (s.spineBend) pose.spineBend = s.spineBend;
  return pose;
}

const between = (a, b, t) => build(lerpSpec(a, b, t));

// Equipment primitives (rendered by exercises.js):
//   { kind: "weight", at, r } | { kind: "kb", at } | { kind: "line", a, b, cls }
//   { kind: "rect", x, y, w, h } | { kind: "ring", at, r } | { kind: "path", d, cls }
const weight = (at, r = 7) => ({ kind: "weight", at, r });
const line = (a, b, cls = "bar") => ({ kind: "line", a, b, cls });
const rect = (x, y, w, h) => ({ kind: "rect", x, y, w, h });

const STAND = { ankle: [180, 182], shin: 90, thigh: 90, torso: -90 };
const stand = (over = {}) => ({ ...STAND, ...over });

function plankFrom(ankle, dir) {
  // Straight body from the toes: returns hip + matching leg/torso angles.
  const hip = P(ankle, dir, THIGH + SHIN);
  return { hip, torso: dir, thigh: dir + 180, shin: dir + 180, footDir: dir + 90 };
}

/** Pattern table: each entry returns { ...joints, muscles, equip, noFloor }. */
const POSES = {
  squat(t) {
    const p = between(
      { hip: [180, 97], ankle: [180, 182], torso: -88, handRel: [50, 6], elbow: 1 },
      { hip: [154, 140], ankle: [180, 182], torso: -56, handRel: [48, 8], elbow: 1 }, t);
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.5), p.hip] };
  },
  box_squat(t) {
    const p = between(
      { hip: [180, 97], ankle: [182, 182], torso: -88, handRel: [50, 6] },
      { hip: [152, 128], ankle: [182, 182], torso: -62, handRel: [48, 8] }, t);
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.5), p.hip], equip: [rect(108, 134, 40, 52)] };
  },
  leg_press(t) {
    const p = between(
      { hip: [150, 150], ankle: [226, 114], knee: -1, torso: -150, hand: [160, 156], footDir: -115 },
      { hip: [150, 150], ankle: [197, 128], knee: -1, torso: -150, hand: [160, 156], footDir: -115 }, t);
    const plate = [P(p.ankle, 65, 4), P(p.ankle, -115, 26)];
    return {
      ...p,
      muscles: [mixPt(p.hip, p.knee, 0.5), p.hip],
      equip: [
        line(P(plate[0], 65, 10), plate[1], "frame"),
        line([96, 122], [156, 158], "frame"),
        line([140, 160], [176, 160], "frame"),
      ],
    };
  },
  rdl(t) {
    const p = between(
      { hip: [180, 97], ankle: [180, 182], torso: -86, handRel: [2, 53] },
      { hip: [160, 104], ankle: [180, 182], torso: -18, handRel: [0, 53] }, t);
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.45), p.hip], equip: [weight(p.hand)] };
  },
  deadlift(t) {
    const p = between(
      { hip: [158, 126], ankle: [180, 182], torso: -22, handRel: [0, 53] },
      { hip: [180, 97], ankle: [180, 182], torso: -88, handRel: [2, 53] }, t);
    return {
      ...p,
      muscles: [p.hip, mixPt(p.hip, p.shoulder, 0.35)],
      equip: [{ kind: "weight", at: p.hand, r: 15 }],
    };
  },
  swing(t) {
    const p = between(
      { hip: [180, 97], ankle: [180, 182], torso: -86, handRel: [52, 6] },
      { hip: [160, 106], ankle: [180, 182], torso: -24, handRel: [-30, 48] }, t);
    return { ...p, muscles: [p.hip, mixPt(p.hip, p.knee, 0.45)], equip: [{ kind: "kb", at: p.hand }] };
  },
  calf_raise(t) {
    const ankle = mixPt([180, 182], [177, 168], t);
    const p = build({ hip: [ankle[0] + 1, ankle[1] - 85], ankle, torso: -90, handRel: [3, 53], footDir: mix(0, 42, t) });
    return { ...p, muscles: [mixPt(p.knee, p.ankle, 0.35)] };
  },
  bridge(t) {
    const p = between(
      { hip: [165, 172], ankle: [216, 182], knee: -1, torso: 180, handRel: [53, 5], elbow: -1 },
      { hip: [170, 142], ankle: [216, 182], knee: -1, torso: 164, handRel: [53, 12], elbow: -1 }, t);
    return { ...p, muscles: [p.hip, mixPt(p.hip, p.knee, 0.4)] };
  },
  hip_thrust(t) {
    const p = between(
      { hip: [160, 174], ankle: [212, 182], knee: -1, torso: -148, hand: [160, 164], elbow: -1 },
      { hip: [165, 140], ankle: [212, 182], knee: -1, torso: -192, hand: [165, 130], elbow: -1 }, t);
    return { ...p, muscles: [p.hip], equip: [rect(62, 152, 56, 34), weight(add(p.hip, [0, -9]), 8)] };
  },
  lunge(t) {
    const p = between(
      { hip: [188, 97], ankle: [192, 182], torso: -88, handRel: [3, 53], bAnkle: [184, 182], bFootDir: 0 },
      { hip: [154, 136], ankle: [192, 182], torso: -82, handRel: [3, 53], bAnkle: [112, 178], bFootDir: 20 }, t);
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.5), p.hip], equip: [weight(p.hand)] };
  },
  step_up(t) {
    const p = between(
      { hip: [180, 114], ankle: [214, 164], torso: -84, handRel: [3, 53], bAnkle: [168, 182], bFootDir: 0 },
      { hip: [212, 84], ankle: [214, 164], torso: -88, handRel: [3, 53], bAnkle: [198, 160], bFootDir: 25 }, t);
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.5), p.hip], equip: [rect(190, 168, 64, 18), weight(p.hand)] };
  },
  leg_curl(t) {
    const p = between(
      { hip: [160, 138], thigh: 0, shin: 8, torso: -96, hand: [170, 146], footDir: -80 },
      { hip: [160, 138], thigh: 0, shin: 118, torso: -96, hand: [170, 146], footDir: 30 }, t);
    return {
      ...p,
      muscles: [mixPt(p.hip, p.knee, 0.5)],
      equip: [rect(124, 144, 88, 7), line([126, 144], [116, 84], "frame"), weight(add(p.ankle, [0, 6]), 6)],
    };
  },
  push_up(t) {
    const a = { ...plankFrom([96, 180], -24), hand: [224, 182], elbow: 1 };
    const b = { ...plankFrom([96, 180], -8), hand: [224, 182], elbow: 1 };
    const p = between(a, b, t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.15), mixPt(p.shoulder, p.elbow, 0.5)] };
  },
  incline_push_up(t) {
    const a = { ...plankFrom([110, 180], -37), hand: [222, 152], elbow: 1 };
    const b = { ...plankFrom([110, 180], -26), hand: [222, 152], elbow: 1 };
    const p = between(a, b, t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.15)], equip: [rect(206, 154, 46, 32)] };
  },
  bench_press(t) {
    const p = between(
      { hip: [130, 144], ankle: [80, 182], knee: 1, footDir: 180, torso: 0, head: 0, hand: [182, 92], elbow: -1 },
      { hip: [130, 144], ankle: [80, 182], knee: 1, footDir: 180, torso: 0, head: 0, hand: [176, 126], elbow: -1 }, t);
    return {
      ...p,
      muscles: [mixPt(p.shoulder, p.hip, 0.2), mixPt(p.shoulder, p.elbow, 0.5)],
      equip: [rect(96, 150, 118, 7), line([110, 157], [110, 186], "frame"), line([200, 157], [200, 186], "frame"), weight(p.hand)],
    };
  },
  floor_press(t) {
    const p = between(
      { hip: [130, 176], ankle: [98, 182], knee: 1, footDir: 180, torso: 0, head: 0, hand: [182, 124], elbow: -1 },
      { hip: [130, 176], ankle: [98, 182], knee: 1, footDir: 180, torso: 0, head: 0, hand: [178, 150], elbow: -1 }, t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.2)], equip: [weight(p.hand)] };
  },
  overhead_press(t) {
    const p = between(stand({ handRel: [12, -4], elbow: 1 }), stand({ handRel: [4, -53], elbow: 1 }), t);
    return { ...p, muscles: [p.shoulder, mixPt(p.shoulder, p.elbow, 0.5)], equip: [weight(p.hand)] };
  },
  lateral_raise(t) {
    // Front view: arms out to both sides.
    const p = frontal(t, { r: [206, 104], l: [154, 104] }, { r: [246, 54], l: [114, 54] }, [-1, 1]);
    return { ...p, muscles: [p.shoulderR, p.shoulderL], equip: [weight(p.hand, 6), weight(p.backHand, 6)] };
  },
  overhead_triceps(t) {
    const p = between(stand({ uarm: -86, farm: -86 }), stand({ uarm: -86, farm: -235 }), t);
    return { ...p, muscles: [mixPt(p.shoulder, p.elbow, 0.5)], equip: [weight(p.hand, 8)] };
  },
  biceps_curl(t) {
    const p = between(stand({ uarm: 92, farm: 92 }), stand({ uarm: 88, farm: -72 }), t);
    return { ...p, muscles: [mixPt(p.shoulder, p.elbow, 0.55)], equip: [weight(p.hand)] };
  },
  pull_apart(t) {
    const p = frontal(t, { r: [204, 62], l: [156, 62] }, { r: [246, 52], l: [114, 52] }, [1, -1]);
    return { ...p, muscles: [p.shoulderR, p.shoulderL], equip: [line(p.hand, p.backHand, "band")] };
  },
  pull_up(t) {
    const p = between(
      { hip: [175, 114], thigh: 96, shin: 140, torso: -88, head: -70, hand: [180, 10], elbow: 1 },
      { hip: [176, 78], thigh: 96, shin: 140, torso: -88, head: -70, hand: [180, 10], elbow: 1 }, t);
    return { ...p, noFloor: true, muscles: [mixPt(p.shoulder, p.hip, 0.3), mixPt(p.shoulder, p.elbow, 0.5)], equip: [line([120, 10], [240, 10])] };
  },
  hang(t) {
    const p = between(
      { hip: [176, 116], thigh: 92, shin: 120, torso: -89, hand: [180, 10] },
      { hip: [176, 112], thigh: 92, shin: 120, torso: -89, hand: [180, 10] }, t);
    return { ...p, noFloor: true, muscles: [p.hand, mixPt(p.shoulder, p.hip, 0.25)], equip: [line([120, 10], [240, 10])] };
  },
  lat_pulldown(t) {
    const p = between(
      { hip: [176, 140], thigh: 0, shin: 90, torso: -96, hand: [184, 34], elbow: 1 },
      { hip: [176, 140], thigh: 0, shin: 90, torso: -106, hand: [190, 82], elbow: 1 }, t);
    return {
      ...p,
      muscles: [mixPt(p.shoulder, p.hip, 0.3)],
      equip: [line(add(p.hand, [-22, 0]), add(p.hand, [22, 0])), line(p.hand, [184, 0], "cable"), rect(150, 146, 52, 7), weight([218, 130], 6)],
    };
  },
  bent_row(t) {
    const p = between(
      { hip: [160, 104], ankle: [180, 182], torso: -18, handRel: [0, 53] },
      { hip: [160, 104], ankle: [180, 182], torso: -18, handRel: [-22, 18], elbow: 1 }, t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.35), p.shoulder], equip: [weight(p.hand)] };
  },
  chest_supported_row(t) {
    const p = between(
      { hip: [150, 134], ankle: [82, 180], knee: -1, footDir: 25, torso: -36, handRel: [0, 53] },
      { hip: [150, 134], ankle: [82, 180], knee: -1, footDir: 25, torso: -36, handRel: [-12, 14], elbow: 1 }, t);
    return {
      ...p,
      muscles: [mixPt(p.shoulder, p.hip, 0.3)],
      equip: [line([136, 154], [200, 108], "frame"), line([162, 138], [162, 186], "frame"), weight(p.hand)],
    };
  },
  seated_row(t) {
    const p = between(
      { hip: [140, 168], ankle: [224, 172], knee: -1, torso: -68, handRel: [52, 8] },
      { hip: [140, 168], ankle: [224, 172], knee: -1, torso: -94, handRel: [14, 22], elbow: 1 }, t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.3)], equip: [line(p.hand, [300, 160], "cable")] };
  },
  standing_row(t) {
    const p = between(
      stand({ hip: [176, 98], torso: -88, handRel: [52, 4] }),
      stand({ hip: [176, 98], torso: -88, handRel: [6, 34], elbow: 1 }), t);
    return { ...p, muscles: [mixPt(p.shoulder, p.hip, 0.3)], equip: [line(p.hand, [326, 74], "band")] };
  },
  hanging_knee_raise(t) {
    const p = between(
      { hip: [176, 112], thigh: 94, shin: 104, torso: -88, hand: [180, 10] },
      { hip: [182, 108], thigh: -6, shin: 92, torso: -84, hand: [180, 10] }, t);
    return { ...p, noFloor: true, muscles: [mixPt(p.hip, p.shoulder, 0.3)], equip: [line([120, 10], [240, 10])] };
  },
  plank(t) {
    const p = build({ ...plankFrom([96, 180], -14 + 1.5 * t), uarm: 90, farm: 0 });
    return { ...p, muscles: [mixPt(p.hip, p.shoulder, 0.45)] };
  },
  side_plank(t) {
    const p = build({ ...plankFrom([96, 180], -20 + 1.5 * t), uarm: 90, farm: -10, bUarm: -92, bFarm: -92 });
    return { ...p, muscles: [mixPt(p.hip, p.shoulder, 0.3)] };
  },
  dead_bug(t) {
    const p = between(
      { hip: [150, 176], torso: 180, thigh: -90, shin: 0, uarm: -90, farm: -90, bThigh: -90, bShin: 0, bUarm: -90, bFarm: -90, footDir: -90, bFootDir: -90 },
      { hip: [150, 176], torso: 180, thigh: -12, shin: -12, uarm: -90, farm: -90, bThigh: -90, bShin: 0, bUarm: -168, bFarm: -170, footDir: -100, bFootDir: -90 }, t);
    return { ...p, muscles: [mixPt(p.hip, p.shoulder, 0.4)] };
  },
  bird_dog(t) {
    // Front arm reaches forward while the back leg extends; the other hand
    // and knee stay planted.
    const p = between(
      { hip: [150, 136], torso: -4, thigh: 90, shin: 180, footDir: 90, uarm: 90, farm: 90, bThigh: 90, bShin: 180, bFootDir: 90, bHand: [202, 182] },
      { hip: [150, 136], torso: -4, thigh: 90, shin: 180, footDir: 90, uarm: -6, farm: -6, bThigh: 178, bShin: 178, bFootDir: 90, bHand: [202, 182] }, t);
    return { ...p, muscles: [mixPt(p.hip, p.shoulder, 0.4), p.hip] };
  },
  walk(t) { return gait(t, { swing: 24, bend: 18, arm: 22, lean: -86, bob: 2 }); },
  incline_walk(t) {
    const p = gait(t, { swing: 22, bend: 20, arm: 18, lean: -80, bob: 2 });
    return { ...p, noFloor: true, equip: [line([70, 196], [300, 168], "frame")] };
  },
  run(t) { return gait(t, { swing: 36, bend: 70, arm: 36, lean: -80, bob: 5, bentArms: true }); },
  bike(t) {
    const ang = 360 * t;
    const crank = [196, 160];
    const a1 = P(crank, ang, 17);
    const a2 = P(crank, ang + 180, 17);
    const p = build({ hip: [168, 110], ankle: a1, knee: -1, torso: -42, hand: [234, 96], elbow: 1, bAnkle: a2, bKnee: -1 });
    return {
      ...p,
      muscles: [mixPt(p.hip, p.knee, 0.5)],
      equip: [
        { kind: "ring", at: [130, 166], r: 20 }, { kind: "ring", at: [262, 166], r: 20 },
        line([162, 116], crank, "frame"), line(crank, [238, 90], "frame"), line([130, 166], crank, "frame"),
        line([238, 90], [262, 166], "frame"), line([152, 116], [174, 116], "frame"),
      ],
    };
  },
  rowing_machine(t) {
    const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
    const p = between(
      { hip: [168, 160], ankle: [216, 164], knee: -1, torso: -60, hand: [214, 128], elbow: 1, footDir: -70 },
      { hip: [132, 160], ankle: [216, 164], knee: -1, torso: -104, hand: [160, 124], elbow: -1, footDir: -70 }, s);
    return {
      ...p,
      noFloor: true,
      muscles: [mixPt(p.hip, p.knee, 0.5), mixPt(p.shoulder, p.hip, 0.3)],
      equip: [line([90, 170], [300, 170], "frame"), line(p.hand, [292, 140], "cable"), { kind: "ring", at: [292, 150], r: 14 }],
    };
  },
  jump_rope(t) {
    const hop = 7 * Math.abs(Math.sin(Math.PI * 2 * t));
    const p = build({ hip: [180, 96 - hop], ankle: [180, 182 - hop], torso: -90, uarm: 100, farm: 10, footDir: hop > 2 ? 30 : 0 });
    // Side view: the rope loops from the hands around the body (over the
    // head, in front, under the feet, behind).
    const ang = 360 * t - 90;
    const far = P([182, 102], ang, 112);
    const c1 = P(far, ang + 90, 42);
    const c2 = P(far, ang - 90, 42);
    return {
      ...p,
      muscles: [mixPt(p.knee, p.ankle, 0.35)],
      equip: [{ kind: "path", d: `M ${p.hand[0]} ${p.hand[1]} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p.hand[0]} ${p.hand[1]}`, cls: "band" }],
    };
  },
  march(t) {
    const s = Math.sin(2 * Math.PI * t);
    const up = Math.max(0, s);
    const down = Math.max(0, -s);
    const p = build({
      hip: [180, 96], torso: -90,
      thigh: 90 - 80 * up, shin: 90, bThigh: 90 - 80 * down, bShin: 90,
      uarm: 90 + 35 * s, farm: 90 + 35 * s - 70, bUarm: 90 - 35 * s, bFarm: 90 - 35 * s - 70,
    });
    return { ...p, muscles: [mixPt(p.hip, p.knee, 0.4)] };
  },
  hip_flexor_stretch(t) {
    const p = between(
      { hip: [160, 140], ankle: [216, 182], torso: -90, uarm: 92, farm: 92, bAnkle: [108, 180], bKnee: -1, bFootDir: 0 },
      { hip: [172, 141], ankle: [216, 182], torso: -94, uarm: -96, farm: -100, bAnkle: [108, 180], bKnee: -1, bFootDir: 0 }, t);
    return { ...p, muscles: [mixPt(p.hip, p.backKnee, 0.35)] };
  },
  cat_cow(t) {
    const p = between(
      { hip: [150, 138], torso: -2, head: -40, thigh: 90, shin: 180, footDir: 90, hand: [200, 182], spineBend: -10, bThigh: 90, bShin: 180, bHand: [200, 182] },
      { hip: [150, 136], torso: -2, head: 110, thigh: 90, shin: 180, footDir: 90, hand: [200, 182], spineBend: 14, bThigh: 90, bShin: 180, bHand: [200, 182] }, t);
    return { ...p, muscles: [mixPt(p.hip, p.shoulder, 0.5)] };
  },
  worlds_greatest_stretch(t) {
    const p = between(
      { hip: [168, 146], ankle: [222, 182], torso: -36, hand: [214, 182], elbow: 1, bAnkle: [96, 178], bKnee: 1, bFootDir: 30, bUarm: 88, bFarm: 88 },
      { hip: [168, 146], ankle: [222, 182], torso: -50, hand: [216, 182], elbow: 1, bAnkle: [96, 178], bKnee: 1, bFootDir: 30, bUarm: -92, bFarm: -92 }, t);
    return { ...p, muscles: [p.hip, mixPt(p.hip, p.shoulder, 0.5)] };
  },
};

/** Front-view figure (both arms visible), used for raises / pull-aparts. */
function frontal(t, a, b, [bendR, bendL] = [-1, 1]) {
  const neck = [180, 48];
  const shoulderR = [194, 50];
  const shoulderL = [166, 50];
  const hipR = [189, 100];
  const hipL = [171, 100];
  const hand = mixPt(a.r, b.r, t);
  const backHand = mixPt(a.l, b.l, t);
  return {
    frontal: true,
    head: [180, 29], shoulder: neck, hip: [180, 100], shoulderR, shoulderL, hipR, hipL,
    knee: [192, 142], ankle: [194, 182], foot: [202, 184],
    backKnee: [168, 142], backAnkle: [166, 182], backFoot: [158, 184],
    elbow: ik(shoulderR, hand, UARM, FARM, bendR), hand,
    backElbow: ik(shoulderL, backHand, UARM, FARM, bendL), backHand,
  };
}

/** Walking / running gait; t is the cycle position. */
function gait(t, { swing, bend, arm, lean, bob, bentArms = false }) {
  const s = Math.sin(2 * Math.PI * t);
  const c = Math.cos(2 * Math.PI * t);
  const lift = (phase) => Math.max(0, phase);
  const hip = [180, 97 - bob * Math.abs(c)];
  const p = build({
    hip, torso: lean,
    thigh: 90 - swing * s, shin: 90 - swing * s + bend * lift(-c) + 6,
    bThigh: 90 + swing * s, bShin: 90 + swing * s + bend * lift(c) + 6,
    uarm: 90 + arm * s, farm: bentArms ? 90 + arm * s - 85 : 90 + arm * s - 15,
    bUarm: 90 - arm * s, bFarm: bentArms ? 90 - arm * s - 85 : 90 - arm * s - 15,
  });
  return { ...p, muscles: [mixPt(p.hip, p.knee, 0.45), mixPt(p.knee, p.ankle, 0.4)] };
}

const GENERIC = (t) => {
  const p = build(stand({ handRel: [3, 53] }));
  return { ...p, muscles: [], breathing: t };
};

export const POSE_PATTERNS = Object.keys(POSES);

export function computePose(pattern, t) {
  const fn = POSES[pattern] || GENERIC;
  const pose = fn(Math.min(Math.max(t, 0), 1));
  pose.equip = pose.equip || [];
  pose.muscles = pose.muscles || [];
  return pose;
}
