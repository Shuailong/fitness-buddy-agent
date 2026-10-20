// Exercise Form Guide (Biomechanical SVG Animation + Cues + Mistakes)
// and Live Camera AI Form Coach with Real-Time Voice Feedback (TTS).
import { el, icon } from "./util.js";
import { getLang } from "./i18n.js";
import { openModal, closeModal, showToast } from "./modal.js";
import { getPersona, getPersonaId, speakCoachText, stopCoachSpeech, unlockCoachAudio, personaSwitchPill } from "./personas.js";
import { track } from "./telemetry.js";

// Localized exercise names & muscle mappings for the 50-exercise catalog
export const EXERCISE_NAMES_ZH = {
  bodyweight_squat: "徒手深蹲",
  goblet_squat: "高脚杯深蹲",
  barbell_back_squat: "杠铃颈后深蹲",
  box_squat_to_bench: "箱式深蹲（护膝半程）",
  dumbbell_romanian_deadlift: "哑铃罗马尼亚硬拉 (RDL)",
  barbell_deadlift: "传统杠铃硬拉",
  glute_bridge: "徒手臀桥",
  dumbbell_hip_thrust: "哑铃臀推",
  reverse_lunge: "后撤步弓步蹲",
  dumbbell_step_up: "哑铃登阶",
  single_leg_glute_bridge: "单腿臀桥",
  standing_calf_raise: "站姿提踵",
  leg_press: "器械倒蹬",
  hamstring_curl_machine: "器械腿弯举",
  push_up: "标准俯卧撑",
  incline_push_up: "上斜俯卧撑",
  dumbbell_bench_press: "哑铃平板卧推",
  dumbbell_floor_press: "哑铃地板卧推",
  barbell_bench_press: "杠铃平板卧推",
  dumbbell_shoulder_press: "哑铃推举",
  dumbbell_lateral_raise: "哑铃侧平举",
  band_pull_apart: "弹力带对拉",
  pull_up: "正手引体向上",
  band_assisted_pull_up: "弹力带辅助引体向上",
  dead_hang: "单杠悬垂",
  one_arm_dumbbell_row: "单臂哑铃划船",
  chest_supported_dumbbell_row: "俯卧上斜哑铃划船",
  barbell_bent_over_row: "杠铃俯身划船",
  lat_pulldown: "高位下拉",
  seated_cable_row: "坐姿绳索划船",
  band_row: "弹力带划船",
  dumbbell_biceps_curl: "哑铃二头弯举",
  dumbbell_triceps_extension: "哑铃颈后臂屈伸",
  kettlebell_swing: "壶铃摇摆 (Swing)",
  kettlebell_goblet_squat: "壶铃高脚杯深蹲",
  plank: "平板支撑",
  side_plank: "侧桥支撑",
  dead_bug: "死虫式核心抗伸展",
  bird_dog: "鸟狗式核心稳定",
  hanging_knee_raise: "悬垂举膝",
  brisk_walk: "快走有氧",
  treadmill_incline_walk: "跑步机坡度走",
  outdoor_run: "户外慢跑",
  stationary_bike_intervals: "动感单车间歇",
  rowing_machine_steady: "划船机稳态有氧",
  jump_rope_intervals: "跳绳间歇",
  low_impact_cardio_circuit: "低冲击全身燃脂循环",
  hip_flexor_stretch: "半跪姿髂腰肌拉伸",
  cat_cow: "猫牛式脊柱灵活训练",
  worlds_greatest_stretch: "最伟大拉伸 (全身动态激活)",
};

// Archetype-level detailed biomechanical guides (bilingual)
const ARCHETYPE_GUIDES = {
  squat: {
    tempo: "3s 下放 · 1s 底部 · 1.5s 蹬起",
    tempoEn: "3s lower · 1s bottom · 1.5s drive",
    musclesZh: ["股四头肌", "臀大肌", "核心稳定肌群"],
    musclesEn: ["Quadriceps", "Glutes", "Core Stabilizers"],
    zh: {
      breathing: "下蹲前深吸气沉入腹腔（瓦氏/腹式呼吸绷紧核心），过了起身最难贴点后呼气。",
      cues: [
        { title: "准备姿态 (Setup)", text: "双脚与肩同宽或略宽，脚尖自然外展 15°–30°；三点足弓（大脚趾根、小脚趾根、脚后跟）均匀抓地，挺胸沉肩。" },
        { title: "发力轨迹 (Execution)", text: "髋部与膝关节同时解锁下蹲，膝盖始终顺着脚尖方向推进；下蹲至大腿至少与地面平行，保持脊柱中立不眨眼（不卷尾骨）。" },
        { title: "向心蹬伸 (Drive)", text: "想象用全脚掌把地面踩裂，臀腿协同发力平稳站起，顶部轻轻收紧臀部，膝关节保持微屈不锁死。" },
      ],
      mistakes: [
        { bad: "膝盖内扣 (Knee Valgus)", fix: "起身时主动发力将膝盖向小脚趾外侧推开，激活臀中肌。" },
        { bad: "重心前移踮脚尖 / 早安式撅臀起身", fix: "重心稳在足中，胸口与髋部保持相同速率同步上升。" },
      ],
    },
    en: {
      breathing: "Inhale deeply into your belly to brace before descending; exhale forcefully past the sticking point on the way up.",
      cues: [
        { title: "Setup & Stance", text: "Feet shoulder-width apart with toes turned out 15°–30°. Grip the floor with your tripod foot (heel, big toe base, little toe base) and keep chest proud." },
        { title: "Controlled Descent", text: "Break at the hips and knees simultaneously, tracking your knees directly over your toes until thighs reach at least parallel." },
        { title: "Concentric Drive", text: "Drive the floor away through mid-foot, extending hips and knees together without locking out harshly at the top." },
      ],
      mistakes: [
        { bad: "Knee Valgus (Knees Caving In)", fix: "Actively screw your feet into the floor and push knees out inline with toes." },
        { bad: "Heels Lifting / Hips Shooting Up First", fix: "Keep weight centered over mid-foot and raise chest and hips at the same rate." },
      ],
    },
  },
  hinge: {
    tempo: "3s 屈髋下放 · 1s 拉伸 · 1.5s 推髋",
    tempoEn: "3s hinge back · 1s stretch · 1.5s snap hips",
    musclesZh: ["腘绳肌 (大腿后侧)", "臀大肌", "竖脊肌与背阔肌"],
    musclesEn: ["Hamstrings", "Glutes", "Spinal Erectors & Lats"],
    zh: {
      breathing: "屈髋后推时吸气并保持腹内压，向前推髋站直时短促有力呼气。",
      cues: [
        { title: "准备姿态 (Setup)", text: "双脚与髋同宽，膝盖解锁微屈约 15°–20° 并固定角度；肩胛骨下沉收紧（想象腋下夹紧两颗网球）。" },
        { title: "髋铰链后移 (Hip Hinge)", text: "想象身后有一扇门，用屁股向后顶开门；器械紧贴大腿与小腿前侧垂直下移，直到大腿后侧有强烈拉伸感（通常在小腿中段）。" },
        { title: "推髋锁定 (Lockout)", text: "全脚掌踩实，用臀大肌发力将髋部向前推回直立位，站直即可，切勿靠腰椎向后过伸。" },
      ],
      mistakes: [
        { bad: "弯腰驼背借力（腰椎代偿）", fix: "全程保持脊柱像一根刚性木棍，下放深度以腘绳肌柔韧度为准，不强求触地。" },
        { bad: "做成深蹲（膝盖过度前移下蹲）", fix: "小腿基本保持垂直地面，动作核心是髋关节水平向后移动。" },
      ],
    },
    en: {
      breathing: "Inhale and brace your core as you hinge your hips back; exhale crisply as you drive your hips forward to stand.",
      cues: [
        { title: "Setup & Lat Pack", text: "Stand hip-width apart with a soft 15°–20° knee bend. Pack your lats down as if squeezing oranges in your armpits." },
        { title: "Horizontal Hip Hinge", text: "Push your hips straight back toward the wall behind you while keeping the weight grazing your thighs and shins." },
        { title: "Glute Lockout", text: "Once you feel a deep hamstring stretch at mid-shin, drive your hips forward to stand tall without hyperextending your lower back." },
      ],
      mistakes: [
        { bad: "Rounding the Lower Back", fix: "Stop descending the moment your hips stop moving backward; keep spine neutral." },
        { bad: "Turning the Hinge into a Squat", fix: "Keep shins nearly vertical and focus on horizontal hip travel." },
      ],
    },
  },
  bridge: {
    tempo: "1.5s 上顶 · 2s 顶峰夹臀 · 2s 下放",
    tempoEn: "1.5s drive up · 2s peak squeeze · 2s lower",
    musclesZh: ["臀大肌", "臀中肌", "腘绳肌"],
    musclesEn: ["Gluteus Maximus", "Gluteus Medius", "Hamstrings"],
    zh: {
      breathing: "向上顶髋时呼气并在顶点收紧腹肌，缓慢下放时吸气。",
      cues: [
        { title: "准备姿态 (Setup)", text: "屈膝仰卧（或上背靠凳），脚后跟距离臀部约一掌半，确保顶起时小腿垂直于地面。" },
        { title: "骨盆后倾启动 (Execution)", text: "脚后跟蹬地，通过臀部发力将髋部向上推起，在最高点让肩、髋、膝呈一条直线，顶峰强烈夹紧臀部停留 1–2 秒。" },
        { title: "骨盆与肋骨锁定 (Control)", text: "全程收下巴、肋骨下沉，避免用下背部拱腰代偿。" },
      ],
      mistakes: [
        { bad: "顶起时腰部发酸（骨盆前倾拱腰）", fix: "稍微收紧下腹完成轻微骨盆后倾，只用臀大肌把髋推高。" },
        { bad: "大腿后侧抽筋代偿", fix: "把双脚往臀部方向收回半步，确保小腿在顶点垂直地面。" },
      ],
    },
    en: {
      breathing: "Exhale as you drive your hips up and squeeze at the top; inhale on the controlled descent.",
      cues: [
        { title: "Foot Placement", text: "Set your heels so that your shins are strictly vertical at the top of the bridge." },
        { title: "Glute-Driven Bridge", text: "Drive through your heels to extend the hips until shoulders, hips, and knees form a straight line; hold 2 seconds." },
        { title: "Ribcage Control", text: "Keep chin tucked and ribs stacked over your pelvis so your lower back never arches." },
      ],
      mistakes: [
        { bad: "Arching the Lower Back at the Top", fix: "Tuck your pelvis slightly at lockout and keep ribs down." },
        { bad: "Hamstrings Taking Over", fix: "Bring your feet 2–3 inches closer to your glutes so shins stay vertical." },
      ],
    },
  },
  lunge: {
    tempo: "2.5s 下蹲 · 1s 底部 · 1.5s 蹬回",
    tempoEn: "2.5s lower · 1s bottom · 1.5s drive",
    musclesZh: ["股四头肌", "臀大肌", "单侧髋稳定肌"],
    musclesEn: ["Quads", "Glutes", "Unilateral Hip Stabilizers"],
    zh: {
      breathing: "迈步下蹲时吸气稳住核心，前腿脚后跟蹬地起身时呼气。",
      cues: [
        { title: "站距如铁轨 (Setup)", text: "双脚左右保持与髋同宽（像踩在两条平行铁轨上，不要踩独木桥），核心收紧目视前方。" },
        { title: "前腿主导重心 (Execution)", text: "80% 的重心落在前脚全脚掌，躯干自然微前倾约 15° 以同时募集臀腿；下蹲至前后膝均约呈 90°。" },
        { title: "平稳发力还原 (Drive)", text: "前脚掌与脚后跟同时发力蹬地回到起始位，保持骨盆水平不侧倾。" },
      ],
      mistakes: [
        { bad: "双脚踩在一条线上导致身体摇晃", fix: "迈步时维持左右与髋同宽的横向跨度。" },
        { bad: "前膝内扣或后腿过度用力蹬", fix: "前膝对准第二脚趾，把后腿仅当作平衡支点。" },
      ],
    },
    en: {
      breathing: "Inhale as you step and lower under control; exhale as you drive through your front foot to stand.",
      cues: [
        { title: "Train-Track Stance", text: "Step hip-width apart like standing on train tracks, never a tightrope, to maximize balance." },
        { title: "Front-Leg Load", text: "Keep 80% of your weight on the front mid-foot with a slight 15° torso lean; lower until both knees hit ~90°." },
        { title: "Controlled Drive", text: "Push through the front heel and mid-foot to return smoothly while keeping hips level." },
      ],
      mistakes: [
        { bad: "Tightrope Stepping (Losing Balance)", fix: "Maintain hip-width lateral spacing between your feet." },
        { bad: "Front Knee Caving Inward", fix: "Track the front knee over the middle toes throughout the rep." },
      ],
    },
  },
  push_horizontal: {
    tempo: "2.5s 下放 · 1s 底部 · 1s 推起",
    tempoEn: "2.5s lower · 1s pause · 1s press",
    musclesZh: ["胸大肌", "肱三头肌", "三角肌前束"],
    musclesEn: ["Pectorals", "Triceps", "Anterior Deltoids"],
    zh: {
      breathing: "下放拉伸胸肌时深吸气，发力向上推起时呼气。",
      cues: [
        { title: "肩胛后缩下沉 (Setup)", text: "收紧并下沉肩胛骨贴稳凳面（或俯卧撑时撑满地面并收紧腹臀），双手握距略宽于肩。" },
        { title: "45°–60° 黄金肘角 (Execution)", text: "下放时大臂与身体躯干呈 45°–60° 夹角（箭头形而非 T 字形），落点位于下胸/乳头连线位置。" },
        { title: "向心内收推起 (Press)", text: "想象把二头肌向中间挤压，平稳将重量推回肩部正上方，保持肩膀始终沉在后面。" },
      ],
      mistakes: [
        { bad: "手肘外展 90° 成 T 字（易伤肩袖）", fix: "主动做一点大臂外旋（折弯杠铃感），让手肘自然内收至 45°–60°。" },
        { bad: "推起时耸肩或俯卧撑塌腰", fix: "全程锁住核心与臀部，推到顶端也不要把肩胛骨耸向耳朵。" },
      ],
    },
    en: {
      breathing: "Inhale as you lower under control; exhale as you press back to the top.",
      cues: [
        { title: "Pack Your Scapulae", text: "Retract and depress your shoulder blades; brace glutes and abs so your body stays rigid." },
        { title: "45°–60° Arrow Elbow Path", text: "Tuck your elbows at a 45°–60° angle relative to your torso (an arrow shape, never a 90° T-shape)." },
        { title: "Smooth Press", text: "Press up in a controlled arc to shoulder level while keeping your shoulders pinned down." },
      ],
      mistakes: [
        { bad: "Flaring Elbows Out to 90°", fix: "Tuck elbows to ~45° to protect the shoulder joint and recruit more chest." },
        { bad: "Sagging Hips or Shrugging", fix: "Squeeze glutes and abs tight from start to finish." },
      ],
    },
  },
  push_vertical: {
    tempo: "2s 上推/举起 · 1s 顶峰 · 2.5s 下放",
    tempoEn: "2s lift · 1s top · 2.5s lower",
    musclesZh: ["三角肌前/中束", "肱三头肌", "核心抗伸展"],
    musclesEn: ["Deltoids", "Triceps", "Core Stabilizers"],
    zh: {
      breathing: "向上推举/抬起时呼气，缓慢受控下放时吸气。",
      cues: [
        { title: "沉肩收肋 (Setup)", text: "收紧臀部与腹肌，肋骨下沉不挺肚子；大臂位于肩胛骨平面（微向前内收约 30°）。" },
        { title: "发力轨迹 (Execution)", text: "推举时垂直向上推至头顶正上方；侧平举时想象把哑铃向远方墙壁推开，手肘略高于手腕。" },
        { title: "离心抗重力下放 (Control)", text: "用 2–3 秒缓慢下放回起始位，保持三角肌持续张力，不在底部完全卸力。" },
      ],
      mistakes: [
        { bad: "靠仰腰挺肚子借力推起", fix: "夹紧臀大肌锁死骨盆，若无法维持腰椎中立请降低一档重量。" },
        { bad: "耸肩用斜方肌代偿", fix: "启动前先做一次深呼吸沉肩，脖子拉长。" },
      ],
    },
    en: {
      breathing: "Exhale as you press or raise the weight; inhale during the slow 2–3s lowering phase.",
      cues: [
        { title: "Ribs Down & Glutes Tight", text: "Squeeze glutes and brace abs so your ribcage stays stacked over your pelvis." },
        { title: "Scapular Plane Path", text: "Work slightly in front of the torso (~30° scapular plane) for smooth, impingement-free shoulder mechanics." },
        { title: "Controlled Eccentric", text: "Lower in 2.5 seconds without letting the weight crash at the bottom." },
      ],
      mistakes: [
        { bad: "Arching the Lower Back to Move Weight", fix: "Keep glutes squeezed and ribs tucked; lighten the load if your back arches." },
        { bad: "Shrugging Upper Traps", fix: "Depress your shoulders away from your ears before every rep." },
      ],
    },
  },
  pull_vertical: {
    tempo: "1.5s 拉起 · 1s 顶峰夹背 · 2.5s 还原",
    tempoEn: "1.5s pull · 1s squeeze · 2.5s lower",
    musclesZh: ["背阔肌", "大圆肌", "肱二头肌与前臂"],
    musclesEn: ["Latissimus Dorsi", "Upper Back", "Biceps & Grip"],
    zh: {
      breathing: "沉肩下拉/拉起时呼气，缓慢伸展还原时吸气。",
      cues: [
        { title: "肩胛下沉启动 (Setup)", text: "握距略宽于肩，启动第一步永远是「沉肩」（把肩胛骨往下压离耳朵），挺胸微迎杠。" },
        { title: "手肘向下插向裤兜 (Execution)", text: "想象双手只是挂钩，发力把两侧手肘向下、向身体两侧肋骨方向拉，直到下巴过杠或横杆触达上胸。" },
        { title: "受控充分伸展 (Control)", text: "用 2–3 秒缓慢还原，感受背阔肌像扇子一样完全展开，但保持肩关节稳定不脱臼。" },
      ],
      mistakes: [
        { bad: "耸肩含胸光靠胳膊硬拉", fix: "每一下动作前先做肩胛下抑，挺起胸骨迎向横杆。" },
        { bad: "身体前后大幅荡秋千借力", fix: "双腿交叉或绷紧核心臀部，保持下肢稳定。" },
      ],
    },
    en: {
      breathing: "Exhale as you depress your shoulders and pull; inhale as you extend back up with control.",
      cues: [
        { title: "Initiate with Scapular Depression", text: "Start every rep by pulling your shoulder blades down away from your ears and lifting your sternum." },
        { title: "Drive Elbows into Back Pockets", text: "Think of your hands as hooks and drive your elbows straight down toward your hips." },
        { title: "Full Controlled Stretch", text: "Take 2–3 seconds to return to full extension to maximize lat hypertrophy." },
      ],
      mistakes: [
        { bad: "Shrugging & Rounding the Shoulders", fix: "Keep chest proud and shoulders depressed at the peak contraction." },
        { bad: "Kipping or Swinging Momentum", fix: "Brace abs and glutes to keep your lower body quiet." },
      ],
    },
  },
  pull_horizontal: {
    tempo: "1.5s 后拉 · 1s 顶峰停留 · 2.5s 下放",
    tempoEn: "1.5s row · 1s peak hold · 2.5s lower",
    musclesZh: ["背阔肌", "菱形肌与中下斜方", "三角肌后束"],
    musclesEn: ["Lats", "Rhomboids & Mid-Back", "Rear Delts"],
    zh: {
      breathing: "向后拉起夹背时呼气，缓慢前伸还原时吸气。",
      cues: [
        { title: "脊柱平直抗旋转 (Setup)", text: "俯身或坐姿时保持背部平直、核心收紧；颈部与脊柱呈一条直线，不要抬头折脖子。" },
        { title: "弧线拉向髋部 (Execution)", text: "先沉肩，手肘贴近身体沿弧线向后上方「裤兜方向」拉起，顶峰夹紧肩胛骨停留 1 秒。" },
        { title: "慢速拉伸背部 (Control)", text: "用 2.5 秒缓慢放回，感受背部肌群被充分拉开。" },
      ],
      mistakes: [
        { bad: "拉向胸口导致耸肩和二头肌过劳", fix: "把手肘轨迹改为向后拉向肚脐/髋部侧方。" },
        { bad: "靠猛烈扭动躯干甩起重量", fix: "保持双肩水平，只在顶峰能稳稳停住 1 秒的重量才是有效重量。" },
      ],
    },
    en: {
      breathing: "Exhale as you row and squeeze your shoulder blades; inhale as you lower slowly.",
      cues: [
        { title: "Neutral Spine & Anti-Rotation", text: "Keep your spine flat, core braced, and neck neutral inline with your torso." },
        { title: "Arc Row Toward the Hip", text: "Sweep your elbow back in an arc toward your hip pocket—not straight up to your neck—and pause 1s at the top." },
        { title: "Controlled Protraction", text: "Lower over 2.5 seconds to feel a full stretch across your lats and mid-back." },
      ],
      mistakes: [
        { bad: "Rowing High into a Neck Shrug", fix: "Pull low toward your hip crease and keep shoulders away from ears." },
        { bad: "Twisting the Torso for Momentum", fix: "Keep shoulders square and use a weight you can pause for 1 full second." },
      ],
    },
  },
  core: {
    tempo: "均匀腹式呼吸 · 全程等长收紧",
    tempoEn: "Steady diaphragmatic breathing · Full-body tension",
    musclesZh: ["腹横肌", "腹直肌与腹斜肌", "深层核心稳定肌"],
    musclesEn: ["Transverse Abdominis", "Rectus Abdominis & Obliques", "Deep Core"],
    zh: {
      breathing: "绝不憋气！保持慢速鼻吸口呼，呼气时想象把肚脐拉向脊柱、肋骨往下收拢。",
      cues: [
        { title: "骨盆后倾锁死腰椎 (Setup)", text: "平板支撑时手肘位于肩部正下方；死虫式时下背部死死压紧地面，绝不留出空隙。" },
        { title: "全身协同刚性 (Execution)", text: "同时夹紧臀大肌、收紧大腿前侧股四头肌，把手肘和脚尖在地面上向中间做等长「对拉」发力。" },
        { title: "抗伸展与抗旋转 (Control)", text: "动作宁慢勿快，一旦下背部开始酸痛或塌腰，立即休息调整，不要硬撑伤腰。" },
      ],
      mistakes: [
        { bad: "塌腰撅屁股导致腰椎受压", fix: "像卷尾骨一样微收臀部，让肋骨与骨盆正面相互靠近。" },
        { bad: "全程憋气面红耳赤", fix: "维持「核心收紧状态下的浅慢呼吸」，训练真正的动态核心稳定。" },
      ],
    },
    en: {
      breathing: "Never hold your breath—take slow nasal inhales and forceful exhales that knit your ribs down.",
      cues: [
        { title: "Posterior Pelvic Tilt", text: "Stack elbows directly under shoulders (or press lower back flat into the floor on Dead Bugs)." },
        { title: "Full-Body Tension", text: "Squeeze glutes and quads simultaneously while pulling elbows toward toes isometrically." },
        { title: "Quality Over Duration", text: "End the set the moment your lower back starts to arch or sag." },
      ],
      mistakes: [
        { bad: "Hips Sagging & Lower Back Arching", fix: "Tuck your tailbone slightly and squeeze your glutes hard." },
        { bad: "Holding Breath", fix: "Breathe steadily behind a braced abdominal wall." },
      ],
    },
  },
  mobility: {
    tempo: "均匀深呼吸 · 每次呼气加深幅度",
    tempoEn: "Deep rhythmic breathing · Sink deeper on exhales",
    musclesZh: ["关节活动度", "心肺耐力", "姿态张力释放"],
    musclesEn: ["Joint Mobility", "Cardiorespiratory", "Postural Relief"],
    zh: {
      breathing: "采用 4秒鼻吸 — 6秒慢呼，利用长呼气激活副交感神经，让紧绷肌群自然放松。",
      cues: [
        { title: "无痛活动范围 (Setup)", text: "在完全无关节刺痛的舒适范围内启动动作，保持躯干挺拔、步伐轻盈。" },
        { title: "呼吸带动幅度 (Execution)", text: "拉伸与灵活性动作中，吸气时蓄力延展脊柱，呼气时顺势多打开 1–2 厘米活动度；有氧动作保持均匀步频与核心轻收。" },
        { title: "心率与姿态监控 (Control)", text: "保持能完整说出一句话的呼吸节奏（Zone 2 黄金燃脂区间），落地轻柔缓冲。" },
      ],
      mistakes: [
        { bad: "憋气暴力弹震式压韧带", fix: "避免猛烈弹震，用深长呼气引导肌肉主动放松。" },
        { bad: "有氧时扶着把手含胸驼背", fix: "解放双手自然摆臂，抬头挺胸提升耗氧效率。" },
      ],
    },
    en: {
      breathing: "Use calm 4s nasal inhales and 6s exhales to relax tight fascia or maintain conversational Zone-2 pace.",
      cues: [
        { title: "Pain-Free Range", text: "Move smoothly within a comfortable, pinch-free range of motion with tall posture." },
        { title: "Exhale into the Stretch", text: "Lengthen your spine on the inhale and sink slightly deeper on each slow exhale." },
        { title: "Rhythmic Cadence", text: "For cardio, keep footfalls light and maintain a steady, sustainable cadence." },
      ],
      mistakes: [
        { bad: "Bouncing Aggressively in Stretches", fix: "Use smooth pauses and deep exhales instead of ballistic bouncing." },
        { bad: "Slouching or Hanging on Handrails", fix: "Stand tall and swing arms naturally for full metabolic benefit." },
      ],
    },
  },
};

export function resolveExerciseArchetype(exOrId) {
  const id = typeof exOrId === "string" ? exOrId : (exOrId && (exOrId.exercise_id || exOrId.id)) || "";
  const name = typeof exOrId === "object" && exOrId ? (exOrId.name || "") : String(exOrId || "");
  const probe = `${id} ${name}`.toLowerCase();
  if (/squat|leg_press|深蹲|倒蹬/.test(probe)) return "squat";
  if (/deadlift|swing|rdl|硬拉|摇摆|摆荡/.test(probe)) return "hinge";
  if (/bridge|thrust|臀桥|臀推/.test(probe)) return "bridge";
  if (/lunge|step_up|calf|curl_machine|弓步|登阶|提踵|腿弯举/.test(probe)) return "lunge";
  if (/push_up|bench_press|floor_press|俯卧撑|卧推/.test(probe)) return "push_horizontal";
  if (/shoulder_press|lateral_raise|triceps|推举|侧平举|臂屈伸/.test(probe)) return "push_vertical";
  if (/pull_up|pulldown|dead_hang|knee_raise|引体|下拉|悬垂|举膝/.test(probe)) return "pull_vertical";
  if (/row|biceps_curl|pull_apart|划船|弯举|对拉/.test(probe)) return "pull_horizontal";
  if (/plank|dead_bug|bird_dog|平板|侧桥|死虫|鸟狗/.test(probe)) return "core";
  return "mobility";
}

export function getExerciseGuide(exOrId, lang = getLang()) {
  const isZh = lang === "zh";
  const id = typeof exOrId === "string"
    ? exOrId
    : (exOrId && (exOrId.exercise_id || exOrId.id)) || "";
  const rawName = typeof exOrId === "object" && exOrId
    ? (exOrId.name || id)
    : String(exOrId || "");
  const zhName = EXERCISE_NAMES_ZH[id] || rawName;
  const displayName = isZh
    ? (EXERCISE_NAMES_ZH[id] ? `${EXERCISE_NAMES_ZH[id]} (${rawName})` : rawName)
    : rawName;
  const archetype = resolveExerciseArchetype(exOrId);
  const archData = ARCHETYPE_GUIDES[archetype] || ARCHETYPE_GUIDES.squat;
  const copy = archData[isZh ? "zh" : "en"];
  const videoQuery = encodeURIComponent(`${rawName} exercise form tutorial proper technique`);

  return {
    id: id || rawName.toLowerCase().replace(/\s+/g, "_"),
    rawName,
    zhName,
    displayName,
    archetype,
    tempo: isZh ? archData.tempo : archData.tempoEn,
    muscles: isZh ? archData.musclesZh : archData.musclesEn,
    breathing: copy.breathing,
    cues: copy.cues,
    mistakes: copy.mistakes,
    videoUrl: `https://www.youtube.com/results?search_query=${videoQuery}`,
  };
}

/**
 * Computes articulated 2D stick-figure joint coordinates for a given archetype
 * and normalized phase t in [0, 1] (0 = start/top, 1 = peak depth/contraction).
 */
function computePoseKeyframes(archetype, t) {
  const lerp = (a, b) => a + (b - a) * t;
  const pt = (x1, y1, x2, y2) => [lerp(x1, x2), lerp(y1, y2)];

  switch (archetype) {
    case "squat": {
      const ankle = [185, 184];
      const knee = pt(188, 140, 214, 146);
      const hip = pt(178, 98, 146, 142);
      const shoulder = pt(182, 48, 174, 88);
      const head = pt(184, 30, 178, 70);
      const elbow = pt(196, 72, 194, 108);
      const hand = pt(204, 56, 198, 92);
      return {
        head, shoulder, hip, knee, ankle, foot: [204, 184], elbow, hand,
        muscles: [pt(183, 118, 180, 144), pt(172, 98, 142, 138)],
        equipType: "dumbbell_front",
      };
    }
    case "hinge": {
      const ankle = [176, 184];
      const knee = pt(180, 142, 174, 146);
      const hip = pt(176, 98, 136, 104);
      const shoulder = pt(180, 48, 196, 86);
      const head = pt(182, 30, 212, 78);
      const elbow = pt(182, 76, 194, 114);
      const hand = pt(184, 104, 190, 144);
      return {
        head, shoulder, hip, knee, ankle, foot: [195, 184], elbow, hand,
        muscles: [pt(170, 118, 152, 124), pt(170, 98, 134, 102)],
        equipType: "barbell_low",
      };
    }
    case "bridge": {
      const shoulder = [116, 166];
      const head = [96, 162];
      const hip = pt(172, 170, 176, 122);
      const knee = [226, 120];
      const ankle = [226, 182];
      const elbow = [136, 174];
      const hand = pt(170, 164, 174, 118);
      return {
        head, shoulder, hip, knee, ankle, foot: [242, 182], elbow, hand,
        muscles: [pt(172, 170, 176, 124)],
        equipType: "floor_mat",
      };
    }
    case "lunge": {
      const ankle = [208, 184];
      const knee = pt(204, 142, 216, 144);
      const hip = pt(178, 98, 176, 138);
      const shoulder = pt(178, 48, 182, 86);
      const head = pt(178, 30, 184, 68);
      const elbow = pt(178, 76, 180, 112);
      const hand = pt(180, 102, 182, 136);
      const backKnee = pt(154, 142, 148, 174);
      const backAnkle = [122, 184];
      return {
        head, shoulder, hip, knee, ankle, foot: [226, 184], elbow, hand,
        backKnee, backAnkle,
        muscles: [pt(194, 118, 198, 140), pt(174, 100, 172, 136)],
        equipType: "dumbbell_side",
      };
    }
    case "push_horizontal": {
      const ankle = [110, 174];
      const knee = [148, 158];
      const hip = pt(184, 142, 184, 162);
      const shoulder = pt(232, 116, 232, 152);
      const head = pt(252, 106, 252, 144);
      const elbow = pt(226, 148, 214, 136);
      const hand = [232, 178];
      return {
        head, shoulder, hip, knee, ankle, foot: [106, 184], elbow, hand,
        muscles: [pt(224, 122, 224, 154), pt(228, 132, 220, 144)],
        equipType: "floor_mat",
      };
    }
    case "push_vertical": {
      const ankle = [180, 184];
      const knee = [180, 142];
      const hip = [180, 100];
      const shoulder = [180, 56];
      const head = [180, 36];
      const elbow = pt(198, 76, 196, 40);
      const hand = pt(202, 54, 192, 16);
      return {
        head, shoulder, hip, knee, ankle, foot: [196, 184], elbow, hand,
        muscles: [[182, 56], pt(196, 66, 194, 32)],
        equipType: "dumbbell_overhead",
      };
    }
    case "pull_vertical": {
      const barY = 22;
      const hand = [180, barY];
      const elbow = pt(190, 52, 198, 76);
      const shoulder = pt(180, 78, 180, 42);
      const head = pt(180, 60, 180, 24);
      const hip = pt(180, 126, 180, 92);
      const knee = pt(180, 162, 186, 130);
      const ankle = pt(180, 192, 174, 160);
      return {
        head, shoulder, hip, knee, ankle, foot: pt(190, 194, 184, 164), elbow, hand,
        muscles: [pt(176, 92, 176, 58), pt(188, 64, 192, 54)],
        equipType: "pullup_bar",
      };
    }
    case "pull_horizontal": {
      const ankle = [174, 184];
      const knee = [182, 146];
      const hip = [148, 108];
      const shoulder = [202, 74];
      const head = [220, 62];
      const elbow = pt(204, 106, 176, 66);
      const hand = pt(208, 136, 186, 94);
      return {
        head, shoulder, hip, knee, ankle, foot: [192, 184], elbow, hand,
        muscles: [pt(176, 88, 172, 78), pt(196, 74, 184, 68)],
        equipType: "dumbbell_low",
      };
    }
    case "core": {
      const ankle = [108, 174];
      const knee = [148, 164];
      const hip = pt(184, 152, 184, 148);
      const shoulder = [234, 142];
      const head = [254, 138];
      const elbow = [232, 178];
      const hand = [254, 178];
      return {
        head, shoulder, hip, knee, ankle, foot: [104, 184], elbow, hand,
        muscles: [[198, 150], [178, 152]],
        equipType: "floor_mat",
      };
    }
    default: {
      const ankle = [180, 184];
      const knee = pt(184, 142, 198, 146);
      const hip = pt(178, 100, 170, 116);
      const shoulder = pt(180, 52, 186, 62);
      const head = pt(180, 32, 188, 42);
      const elbow = pt(194, 76, 206, 54);
      const hand = pt(206, 92, 218, 34);
      return {
        head, shoulder, hip, knee, ankle, foot: [198, 184], elbow, hand,
        muscles: [[176, 104], [182, 60]],
        equipType: "none",
      };
    }
  }
}

/**
 * Creates an interactive SVG biomechanical animation stage for an exercise.
 */
export function createExerciseAnimStage(guide, { lang = getLang() } = {}) {
  const isZh = lang === "zh";
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 360 210");
  svg.setAttribute("class", "ex-anim-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", guide.displayName);

  const mk = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  // Floor & alignment grid
  svg.append(
    mk("line", { x1: 36, y1: 186, x2: 324, y2: 186, class: "ex-svg-floor" }),
    mk("line", { x1: 180, y1: 18, x2: 180, y2: 186, class: "ex-svg-axis" }),
  );

  const equipGroup = mk("g", { class: "ex-svg-equip" });
  const backLimb = mk("path", { class: "ex-svg-limb-back" });
  const bodyPath = mk("path", { class: "ex-svg-body" });
  const armPath = mk("path", { class: "ex-svg-arm" });
  const headCircle = mk("circle", { r: 11, class: "ex-svg-head" });
  const muscleGroup = mk("g", { class: "ex-svg-muscles" });
  const jointGroup = mk("g", { class: "ex-svg-joints" });

  svg.append(equipGroup, backLimb, bodyPath, armPath, headCircle, muscleGroup, jointGroup);

  const phaseBadge = el("span", { class: "ex-anim-phase-pill" });
  const musclesLine = el("div", { class: "ex-anim-muscles" }, [
    el("span", { class: "muted small", text: isZh ? "目标肌群：" : "Target Muscles: " }),
    ...guide.muscles.map((m) => el("span", { class: "pill pill-primary ex-muscle-tag", text: m })),
  ]);

  let speed = 1.0;
  let paused = false;
  let rafId = 0;
  let startTs = performance.now();

  const speedBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      speed = speed === 1.0 ? 0.5 : 1.0;
      speedBtn.textContent = speed === 1.0 ? (isZh ? "1.0x 原速" : "1.0x Speed") : (isZh ? "0.5x 慢速分解" : "0.5x Slow-Mo");
    },
  }, [isZh ? "1.0x 原速" : "1.0x Speed"]);

  const pauseBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? (isZh ? "▶ 继续演示" : "▶ Play") : (isZh ? "⏸ 暂停定格" : "⏸ Pause");
    },
  }, [isZh ? "⏸ 暂停定格" : "⏸ Pause"]);

  const renderFrame = (now) => {
    const cycleMs = 4200 / speed;
    const elapsed = ((now - startTs) % cycleMs) / cycleMs;
    // Smooth eccentric (0..0.45), hold (0.45..0.60), concentric (0.60..0.92), top pause (0.92..1)
    let t = 0;
    let phaseLabel = "";
    if (elapsed < 0.45) {
      const p = elapsed / 0.45;
      t = 0.5 - 0.5 * Math.cos(Math.PI * p);
      phaseLabel = isZh ? "吸气控制 · 离心阶段" : "Inhale · Eccentric Control";
    } else if (elapsed < 0.60) {
      t = 1;
      phaseLabel = isZh ? "底部/顶峰绷紧 · 保持张力" : "Peak Tension · Hold";
    } else if (elapsed < 0.92) {
      const p = (elapsed - 0.60) / 0.32;
      t = 0.5 + 0.5 * Math.cos(Math.PI * p);
      phaseLabel = isZh ? "呼气发力 · 向心收缩" : "Exhale · Concentric Drive";
    } else {
      t = 0;
      phaseLabel = isZh ? "起始位稳定 · 核心收紧" : "Setup · Core Braced";
    }
    phaseBadge.textContent = phaseLabel;

    const pose = computePoseKeyframes(guide.archetype, t);
    headCircle.setAttribute("cx", String(pose.head[0]));
    headCircle.setAttribute("cy", String(pose.head[1]));

    bodyPath.setAttribute(
      "d",
      `M ${pose.shoulder[0]} ${pose.shoulder[1]} L ${pose.hip[0]} ${pose.hip[1]} L ${pose.knee[0]} ${pose.knee[1]} L ${pose.ankle[0]} ${pose.ankle[1]} L ${pose.foot[0]} ${pose.foot[1]}`
    );
    armPath.setAttribute(
      "d",
      `M ${pose.shoulder[0]} ${pose.shoulder[1]} L ${pose.elbow[0]} ${pose.elbow[1]} L ${pose.hand[0]} ${pose.hand[1]}`
    );

    if (pose.backKnee && pose.backAnkle) {
      backLimb.setAttribute(
        "d",
        `M ${pose.hip[0]} ${pose.hip[1]} L ${pose.backKnee[0]} ${pose.backKnee[1]} L ${pose.backAnkle[0]} ${pose.backAnkle[1]}`
      );
    } else {
      backLimb.setAttribute("d", "");
    }

    // Active muscle glow nodes
    muscleGroup.replaceChildren(...(pose.muscles || []).map(([mx, my]) =>
      mk("circle", {
        cx: mx,
        cy: my,
        r: (7 + 4 * t).toFixed(1),
        class: "ex-svg-muscle-glow",
        style: `opacity: ${(0.35 + 0.55 * t).toFixed(2)}`,
      })
    ));

    // Joints
    jointGroup.replaceChildren(...[pose.shoulder, pose.hip, pose.knee, pose.elbow].map(([jx, jy]) =>
      mk("circle", { cx: jx, cy: jy, r: 4, class: "ex-svg-joint" })
    ));

    // Equipment
    equipGroup.replaceChildren();
    if (pose.equipType === "pullup_bar") {
      equipGroup.append(mk("line", { x1: 120, y1: 22, x2: 240, y2: 22, class: "ex-svg-bar" }));
    } else if (pose.equipType.startsWith("dumbbell") || pose.equipType === "barbell_low") {
      equipGroup.append(mk("circle", { cx: pose.hand[0], cy: pose.hand[1], r: 7, class: "ex-svg-weight" }));
    }

    if (!paused && svg.isConnected) {
      rafId = requestAnimationFrame(renderFrame);
    }
  };

  // Initial paint + loop
  renderFrame(performance.now());
  if (typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    rafId = requestAnimationFrame(function tick(ts) {
      if (! paused) renderFrame(ts);
      if (document.body.contains(svg)) rafId = requestAnimationFrame(tick);
    });
  }

  return el("div", { class: "ex-anim-stage-wrap" }, [
    el("div", { class: "ex-anim-stage" }, [
      el("div", { class: "ex-anim-top-hud" }, [
        phaseBadge,
        el("span", { class: "ex-anim-tempo-tag", text: `⏱ ${guide.tempo}` }),
      ]),
      svg,
      el("div", { class: "ex-anim-controls" }, [speedBtn, pauseBtn]),
    ]),
    musclesLine,
  ]);
}

/**
 * Opens the Exercise Form Guide Modal (Biomechanical Animation + Cues + Mistakes + Video + Live Camera CTA).
 */
export function openExerciseDetailModal(exOrId, actions) {
  const lang = getLang();
  const isZh = lang === "zh";
  const guide = getExerciseGuide(exOrId, lang);
  track("exercise_guide", { exercise_id: guide.id });

  const dialog = el("div", {
    class: "modal-card ex-detail-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "ex-detail-title",
  }, [
    el("header", { class: "modal-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: isZh ? "动作要领与生物力学演示" : "BIOMECHANICS & FORM GUIDE" }),
        el("h3", { id: "ex-detail-title", text: guide.displayName }),
      ]),
      el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": isZh ? "关闭" : "Close",
        onclick: closeModal,
      }, [icon("close")]),
    ]),
    el("div", { class: "ex-detail-body" }, [
      // Built-in biomechanical animation stage
      createExerciseAnimStage(guide, { lang }),

      // Primary Hero CTA: Open Live Camera AI Form Coach with Voice Feedback
      el("div", { class: "ex-live-cta-banner" }, [
        el("div", { class: "ex-live-cta-text" }, [
          el("strong", { text: isZh ? "📷 AI 实时动作观测与语音伴练" : "📷 Live AI Camera Form & Voice Coach" }),
          el("p", {
            class: "muted small",
            text: isZh
              ? "开启摄像头，AI 实时检测你的脊柱角度、关节轨迹与动作幅度，边做边听专属教练实时语音纠错！"
              : "Turn on your camera for real-time posture tracking and live spoken coaching cues while you perform your set!",
          }),
        ]),
        el("button", {
          type: "button",
          class: "btn btn-primary ex-live-start-btn",
          onclick: () => {
            unlockCoachAudio();
            closeModal();
            openLiveFormCoachModal(exOrId, actions);
          },
        }, [icon("videocam"), isZh ? "开启摄像头实时指导" : "Start Live Camera Coach"]),
      ]),

      // 3-step form cues
      el("div", { class: "ex-cues-section" }, [
        el("h4", { class: "ex-sec-title", text: isZh ? "✅ 核心动作要点 (Step-by-Step Cues)" : "✅ Step-by-Step Form Cues" }),
        el("ol", { class: "ex-cue-list" }, guide.cues.map((c, idx) =>
          el("li", { class: "ex-cue-item" }, [
            el("span", { class: "num", text: String(idx + 1) }),
            el("div", {}, [
              el("strong", { text: c.title }),
              el("p", { class: "muted small", text: c.text }),
            ]),
          ])
        )),
      ]),

      // Breathing rule
      el("div", { class: "ex-breath-box" }, [
        icon("air", { cls: "accent" }),
        el("div", {}, [
          el("strong", { text: isZh ? "呼吸与节奏配合：" : "Breathing & Tempo: " }),
          el("span", { class: "small", text: guide.breathing }),
        ]),
      ]),

      // Common mistakes & fixes
      el("div", { class: "ex-mistakes-section" }, [
        el("h4", { class: "ex-sec-title", text: isZh ? "⚠️ 常见错误与纠偏 (Avoid Mistakes)" : "⚠️ Common Mistakes & Fixes" }),
        el("div", { class: "ex-mistake-list" }, guide.mistakes.map((m) =>
          el("div", { class: "ex-mistake-card" }, [
            el("p", { class: "ex-mistake-bad" }, [el("span", { text: "❌ " }), el("strong", { text: m.bad })]),
            el("p", { class: "ex-mistake-fix small" }, [el("span", { text: "✅ " }), el("span", { text: m.fix })]),
          ])
        )),
      ]),

      // Footer links: Watch HD Real-Person Video + Ask Coach to substitute
      el("div", { class: "ex-detail-actions" }, [
        el("a", {
          href: guide.videoUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "btn btn-outline btn-sm",
        }, [icon("play-circle"), isZh ? "观看真人高清视频演示" : "Watch HD Video Tutorial"]),
        el("button", {
          type: "button",
          class: "btn btn-outline btn-sm",
          onclick: () => {
            closeModal();
            if (actions && actions.openCoach) {
              actions.openCoach({
                send: isZh
                  ? `请给我讲讲「${guide.zhName}」的发力细节，以及如果觉得关节不适有哪些平替动作？`
                  : `Can you give me form tips for ${guide.rawName} and suggest joint-friendly alternatives?`,
              });
            }
          },
        }, [icon("smart-toy"), isZh ? "向教练提问 / 换平替动作" : "Ask Coach / Swap Exercise"]),
      ]),
    ]),
  ]);

  openModal(dialog);
}

/**
 * Inspects a 2D canvas frame for brightness & contrast so covered lenses or
 * blank walls are detected immediately instead of hallucinating form scores.
 */
function inspectCanvasFrameStats(ctx, width, height) {
  try {
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    // Sample every 16th pixel for speed
    const step = 16 * 4;
    for (let i = 0; i < data.length; i += step) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      count++;
    }
    if (!count) return "camera";
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const std = Math.sqrt(variance);
    if (mean < 14 && std < 9) return "dark";
    if (std < 5.5) return "blank";
    return "camera";
  } catch {
    return "camera";
  }
}

/**
 * Opens the Live Camera AI Form Coach Studio with real-time frame capture,
 * strict evidence verification, biomechanical HUD overlay, and neural TTS voice feedback.
 */
export function openLiveFormCoachModal(exOrId, actions) {
  if (actions && actions.isDemo && actions.isDemo()) {
    // Live camera coaching is the most expensive feature: signed-in accounts only.
    showToast(getLang() === "zh" ? "实时摄像指导需要登录后使用" : "Live camera coaching needs a signed-in account", { iconName: "lock" });
    return;
  }
  // Synchronously unlock browser audio inside the user click gesture!
  unlockCoachAudio();

  const lang = getLang();
  const isZh = lang === "zh";
  const guide = getExerciseGuide(exOrId, lang);
  track("form_check", { action: "open_studio", exercise_id: guide.id });

  let stream = null;
  let loopTimerId = null;
  let isCoaching = false;
  let inFlight = false;
  let voiceEnabled = true;
  let facingMode = "user";
  let simulationMode = false;
  let frameIndex = 0;
  let repCount = 0;
  let lastScore = null;
  let lastSpokenCue = "";
  let lastSpokenAt = 0;
  let lastAudioB64 = null;
  let lastAudioMime = "audio/wav";

  const videoEl = el("video", {
    class: "live-coach-video is-mirrored",
    autoplay: "",
    playsinline: "",
    muted: "",
  });
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = 640;
  captureCanvas.height = 480;

  const statusBadge = el("span", {
    class: "live-hud-status waiting",
    text: isZh ? "⚪ 正在启动镜头 · 请退后让关键关节入镜" : "⚪ Starting Camera · Step Back Into Frame",
  });
  const scoreBadge = el("span", {
    class: "live-hud-score",
    text: isZh ? "动作评分 --" : "Form Score --",
  });
  const repBadge = el("span", {
    class: "live-hud-reps",
    text: isZh ? "本组计数: 0" : "Reps: 0",
  });

  const observedSceneBar = el("div", {
    class: "live-observed-scene",
    text: isZh
      ? "👁 AI 实时视觉核验中：只有完整看清你的身体关键关节并正在做动作时才会打分，绝不盲目瞎编。"
      : "👁 Strict AI Vision Gate: Scores are only awarded when your body and required joints are clearly visible performing the exercise.",
  });

  const voiceTextEl = el("p", {
    class: "live-voice-text",
    text: isZh
      ? `${getPersona(getPersonaId(), lang).copy.shortName}正在准备语音伴练，请将手机/电脑放稳，确保全身或关键关节入镜…`
      : `${getPersona(getPersonaId(), lang).copy.shortName} is getting ready—place your camera so your body is clearly in frame…`,
  });

  const replayVoiceBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm live-replay-btn",
    title: isZh ? "重播当前教练语音提示" : "Replay current voice cue",
    onclick: async () => {
      unlockCoachAudio();
      const textToSpeak = voiceTextEl.textContent || lastSpokenCue;
      if (!textToSpeak) return;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(textToSpeak, {
        personaId: getPersonaId(),
        lang,
        audioB64: lastAudioB64,
        audioMime: lastAudioMime,
      });
      voiceCueBanner.classList.remove("is-speaking");
    },
  }, [icon("volume-up"), isZh ? "播报" : "Speak"]);

  const voiceCueBanner = el("div", { class: "live-voice-banner" }, [
    icon("volume-up", { cls: "accent live-voice-icon" }),
    voiceTextEl,
    replayVoiceBtn,
  ]);

  const checksWrap = el("div", { class: "live-checks-grid" }, [
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: isZh ? "画面与机位核验" : "Camera & Framing" }),
      el("strong", { text: isZh ? "待检测…" : "Waiting…" }),
    ]),
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: isZh ? "关节轨迹与姿态" : "Joint Tracking" }),
      el("strong", { text: isZh ? "待检测…" : "Waiting…" }),
    ]),
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: isZh ? "动作幅度与节奏" : "Depth & Tempo" }),
      el("strong", { text: isZh ? "待检测…" : "Waiting…" }),
    ]),
  ]);

  const simStageWrap = el("div", { class: "live-sim-fallback", hidden: true }, [
    createExerciseAnimStage(guide, { lang }),
  ]);

  const clearLoopTimer = () => {
    if (loopTimerId) {
      clearTimeout(loopTimerId);
      loopTimerId = null;
    }
  };

  let liveWs = null;
  let wsPendingHandler = null;

  const closeLiveWs = () => {
    wsPendingHandler = null;
    if (liveWs) {
      try {
        liveWs.onopen = null;
        liveWs.onmessage = null;
        liveWs.onerror = null;
        liveWs.onclose = null;
        liveWs.close();
      } catch { /* ignore */ }
      liveWs = null;
    }
  };

  const ensureLiveWs = () => new Promise((resolve) => {
    if (typeof WebSocket === "undefined" || typeof window === "undefined") {
      resolve(null);
      return;
    }
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      resolve(liveWs);
      return;
    }
    closeLiveWs();
    let settled = false;
    const finish = (sock) => {
      if (settled) return;
      settled = true;
      resolve(sock);
    };
    const timer = setTimeout(() => finish(null), 2200);
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/live-coach/ws`);
      liveWs = ws;
      ws.onopen = () => {
        clearTimeout(timer);
        finish(ws);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (wsPendingHandler) wsPendingHandler(msg);
        } catch { /* ignore */ }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        closeLiveWs();
        finish(null);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (liveWs === ws) liveWs = null;
        finish(null);
      };
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });

  const stopAll = () => {
    isCoaching = false;
    clearLoopTimer();
    closeLiveWs();
    if (stream) {
      for (const trk of stream.getTracks()) {
        try { trk.stop(); } catch { /* ignore */ }
      }
      stream = null;
    }
    stopCoachSpeech();
  };

  const startCamera = async () => {
    try {
      if (stream) {
        for (const trk of stream.getTracks()) trk.stop();
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API unavailable");
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      videoEl.srcObject = stream;
      videoEl.classList.toggle("is-mirrored", facingMode === "user");
      videoEl.hidden = false;
      simStageWrap.hidden = true;
      simulationMode = false;
      await videoEl.play().catch(() => {});
      return true;
    } catch {
      // Do NOT silently fake scores when camera fails; inform user honestly!
      simulationMode = false;
      videoEl.hidden = true;
      simStageWrap.hidden = false;
      statusBadge.className = "live-hud-status insufficient";
      statusBadge.textContent = isZh ? "🟠 未获取到摄像头画面 · 可授权镜头或开启演示" : "🟠 Camera Unavailable · Allow Camera or Use Demo";
      scoreBadge.textContent = isZh ? "动作评分 -- (无画面)" : "Score -- (No Video)";
      observedSceneBar.textContent = isZh
        ? "⚠️ 无法访问摄像头：请检查浏览器摄像头权限，或点击下方「切换演示模式」体验标准模拟伴练。"
        : "⚠️ Camera permission denied or unavailable. Check browser permissions or click 'Demo Mode' below.";
      return false;
    }
  };

  const captureFramePayload = () => new Promise((resolve) => {
    const ctx = captureCanvas.getContext("2d");
    if (!simulationMode) {
      if (!stream || videoEl.readyState < 2 || videoEl.videoWidth <= 0) {
        resolve({ blob: null, dataUrl: "", frameHint: "no_video" });
        return;
      }
      captureCanvas.width = 640;
      captureCanvas.height = Math.round((videoEl.videoHeight / videoEl.videoWidth) * 640) || 480;
      ctx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);
      const frameHint = inspectCanvasFrameStats(ctx, captureCanvas.width, captureCanvas.height);
      const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.78);
      captureCanvas.toBlob((blob) => resolve({ blob, dataUrl, frameHint }), "image/jpeg", 0.78);
      return;
    }

    // Explicit Demo / Simulation mode requested by user
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    ctx.fillStyle = "#0F172A";
    ctx.fillRect(0, 0, 640, 480);
    ctx.strokeStyle = "#10B981";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(320, 110, 26, 0, Math.PI * 2);
    ctx.moveTo(320, 136);
    ctx.lineTo(310, 260);
    ctx.lineTo(350, 360);
    ctx.lineTo(340, 440);
    ctx.stroke();
    const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.72);
    captureCanvas.toBlob((blob) => resolve({ blob, dataUrl, frameHint: "simulation" }), "image/jpeg", 0.72);
  });

  const applyVisionHudUpdate = (res) => {
    const status = res.status || "insufficient_evidence";
    const hasValidScore = typeof res.score === "number" && res.evidence_ok !== false && status !== "insufficient_evidence";

    if (!hasValidScore) {
      statusBadge.className = "live-hud-status insufficient";
      statusBadge.textContent = isZh ? "🟠 画面证据不足 · 请调整机位" : "🟠 Insufficient View · Adjust Camera";
      scoreBadge.textContent = isZh ? "动作评分 -- (未入镜)" : "Score -- (Not in Frame)";
    } else {
      lastScore = res.score;
      if (res.rep_increment && Number(res.rep_increment) > 0) {
        repCount += Number(res.rep_increment);
      }
      statusBadge.className = `live-hud-status ${status}`;
      if (status === "good") {
        statusBadge.textContent = isZh ? "🟢 姿态标准 · 保持节奏" : "🟢 Great Form · Keep Going";
      } else if (status === "bad") {
        statusBadge.textContent = isZh ? "🔴 动作变形 · 请立即调整" : "🔴 Form Breakdown · Adjust Now";
      } else {
        statusBadge.textContent = isZh ? "🟡 发现细节可微调" : "🟡 Form Adjustment Cue";
      }
      scoreBadge.textContent = isZh ? `动作评分 ${lastScore}` : `Score ${lastScore}`;
    }
    repBadge.textContent = isZh ? `本组计数: ${repCount}` : `Reps: ${repCount}`;

    if (res.observed_scene) {
      observedSceneBar.textContent = isZh
        ? `👁 AI 画面实测：${res.observed_scene}`
        : `👁 AI Observed: ${res.observed_scene}`;
    }

    if (res.voice_cue) {
      voiceTextEl.textContent = res.voice_cue;
      voiceCueBanner.classList.remove("pulse");
      void voiceCueBanner.offsetWidth;
      voiceCueBanner.classList.add("pulse");
    }

    if (Array.isArray(res.checks) && res.checks.length) {
      checksWrap.replaceChildren(...res.checks.map((chk) =>
        el("div", { class: `live-check-item ${chk.ok ? "ok" : "warn"}` }, [
          el("div", { class: "live-check-top" }, [
            icon(chk.ok ? "check-circle" : "error-outline"),
            el("strong", { text: chk.label }),
          ]),
          el("p", { class: "muted small", text: chk.detail }),
        ])
      ));
    }
    return status;
  };

  const maybePlayCueAudio = async (cueText, status, audioB64, audioMime) => {
    if (!cueText) return;
    if (audioB64) {
      lastAudioB64 = audioB64;
      lastAudioMime = audioMime || "audio/mpeg";
    }
    const now = Date.now();
    const shouldRepeatReminder = status !== "good" && (now - lastSpokenAt > 8500);
    if (voiceEnabled && (cueText !== lastSpokenCue || shouldRepeatReminder)) {
      lastSpokenCue = cueText;
      lastSpokenAt = now;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(cueText, {
        personaId: getPersonaId(),
        lang,
        audioB64: audioB64 || "",
        audioMime: audioMime || "audio/mpeg",
      });
      voiceCueBanner.classList.remove("is-speaking");
    }
  };

  const analyzeViaWebSocket = async ({ dataUrl, frameHint, fIdx }) => {
    const ws = await ensureLiveWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const now = Date.now();
    const wantVoice = voiceEnabled && (now - lastSpokenAt > 2500);

    return new Promise((resolve) => {
      let visionData = null;
      let status = "insufficient_evidence";
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        wsPendingHandler = null;
        resolve(ok);
      };
      const timeoutId = setTimeout(() => {
        finish(Boolean(visionData));
      }, 9500);

      wsPendingHandler = async (msg) => {
        if (!msg || msg.frame_index !== fIdx) return;
        if (msg.type === "vision_result") {
          visionData = msg;
          status = applyVisionHudUpdate(msg);
          if (!wantVoice || !msg.voice_cue) {
            finish(true);
          }
        } else if (msg.type === "voice_audio") {
          wsPendingHandler = null;
          clearTimeout(timeoutId);
          const cue = (visionData && visionData.voice_cue) || msg.voice_cue || "";
          await maybePlayCueAudio(cue, status, msg.audio_b64, msg.audio_mime);
          finish(true);
        } else if (msg.type === "voice_audio_done") {
          wsPendingHandler = null;
          clearTimeout(timeoutId);
          const cue = (visionData && visionData.voice_cue) || "";
          await maybePlayCueAudio(cue, status, "", "");
          finish(true);
        }
      };

      try {
        ws.send(JSON.stringify({
          type: "frame",
          exercise_id: guide.id,
          exercise_name: guide.rawName,
          lang,
          persona: getPersonaId(),
          frame_index: fIdx,
          simulation: simulationMode,
          frame_hint: frameHint,
          voice_enabled: wantVoice,
          image_b64: dataUrl,
        }));
      } catch {
        closeLiveWs();
        finish(false);
      }
    });
  };

  const analyzeSingleFrame = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { blob, dataUrl, frameHint } = await captureFramePayload();
      if (!blob) {
        statusBadge.className = "live-hud-status insufficient";
        statusBadge.textContent = isZh ? "🟠 等待摄像头画面就绪…" : "🟠 Waiting for Camera Video…";
        scoreBadge.textContent = isZh ? "动作评分 -- (未入镜)" : "Score -- (No Video)";
        return;
      }
      const fIdx = frameIndex++;

      // Scheme C primary: Real-time bidirectional WebSocket stream (/api/live-coach/ws)
      if (dataUrl) {
        const wsOk = await analyzeViaWebSocket({ dataUrl, frameHint, fIdx });
        if (wsOk) return;
      }

      // Automatic fallback to HTTP POST /api/form-check if WebSocket is unavailable
      const fd = new FormData();
      fd.append("exercise_id", guide.id);
      fd.append("exercise_name", guide.rawName);
      fd.append("lang", lang);
      fd.append("persona", getPersonaId());
      fd.append("frame_index", String(fIdx));
      fd.append("simulation", simulationMode ? "1" : "0");
      fd.append("frame_hint", frameHint);
      fd.append("image", blob, "frame.jpg");

      const resp = await fetch("/api/form-check", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!resp.ok) return;
      const res = await resp.json();
      const status = applyVisionHudUpdate(res);
      await maybePlayCueAudio(res.voice_cue, status, res.audio_b64, res.audio_mime);
    } catch { /* ignore transient network error */ } finally {
      inFlight = false;
    }
  };

  // Sequential loop: waits for frame analysis + voice playback to finish before scheduling next check
  const runCoachingLoop = async () => {
    clearLoopTimer();
    if (!isCoaching || !document.body.contains(dialog)) return;
    await analyzeSingleFrame();
    if (isCoaching && document.body.contains(dialog)) {
      loopTimerId = setTimeout(runCoachingLoop, 2400);
    }
  };

  const setCoachingState = async (active, { speakIntro = false } = {}) => {
    unlockCoachAudio();
    if (!active) {
      isCoaching = false;
      clearLoopTimer();
      stopCoachSpeech();
      voiceCueBanner.classList.remove("is-speaking");
      toggleBtn.replaceChildren(icon("play-arrow"), isZh ? "继续实时语音指导" : "Resume Live Coach");
      statusBadge.textContent = isZh ? "⏸ 已暂停实时观测" : "⏸ Live Coach Paused";
      return;
    }
    isCoaching = true;
    toggleBtn.replaceChildren(icon("pause"), isZh ? "暂停实时指导" : "Pause Live Coach");
    if (speakIntro && voiceEnabled) {
      const persona = getPersona(getPersonaId(), lang);
      const intro = isZh
        ? `${persona.copy.shortName}就位！请退后让全身关键关节入镜，开始做「${guide.zhName}」，我会严格盯紧你的动作。`
        : `${persona.copy.shortName} ready! Step back so your joints are in frame and start ${guide.rawName}.`;
      voiceTextEl.textContent = intro;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(intro, { personaId: getPersonaId(), lang });
      voiceCueBanner.classList.remove("is-speaking");
    }
    if (isCoaching && document.body.contains(dialog)) {
      await runCoachingLoop();
    }
  };

  const toggleBtn = el("button", {
    type: "button",
    class: "btn btn-primary live-toggle-btn",
    onclick: () => setCoachingState(!isCoaching, { speakIntro: !isCoaching }),
  }, [icon("pause"), isZh ? "暂停实时指导" : "Pause Live Coach"]);

  const voiceToggleBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      unlockCoachAudio();
      voiceEnabled = !voiceEnabled;
      if (!voiceEnabled) {
        stopCoachSpeech();
        voiceCueBanner.classList.remove("is-speaking");
      }
      voiceToggleBtn.replaceChildren(
        icon(voiceEnabled ? "volume-up" : "close"),
        isZh ? (voiceEnabled ? "语音播报: 开" : "语音播报: 静音") : (voiceEnabled ? "Voice: ON" : "Voice: Muted"),
      );
    },
  }, [icon("volume-up"), isZh ? "语音播报: 开" : "Voice: ON"]);

  const flipCamBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: async () => {
      unlockCoachAudio();
      facingMode = facingMode === "user" ? "environment" : "user";
      await startCamera();
    },
  }, [icon("flip-camera-ios"), isZh ? "切换前后镜头" : "Flip Camera"]);

  const demoModeBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: async () => {
      unlockCoachAudio();
      simulationMode = !simulationMode;
      demoModeBtn.replaceChildren(
        icon("auto-awesome"),
        isZh ? (simulationMode ? "退出精讲演示" : "精讲演示模式") : (simulationMode ? "Exit Demo" : "Demo Mode"),
      );
      if (simulationMode) {
        videoEl.hidden = true;
        simStageWrap.hidden = false;
        observedSceneBar.textContent = isZh
          ? "✨ 当前处于「动作精讲演示模式」（非真实摄像头判分），教练将按周期演示各阶段语音指导要点。"
          : "✨ Demo Mode active (simulated frames): Coach will demonstrate voice cues across exercise phases.";
        await analyzeSingleFrame();
      } else {
        await startCamera();
        await analyzeSingleFrame();
      }
    },
  }, [icon("auto-awesome"), isZh ? "精讲演示模式" : "Demo Mode"]);

  const snapNowBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      unlockCoachAudio();
      lastSpokenCue = "";
      analyzeSingleFrame();
    },
  }, [icon("photo-camera"), isZh ? "立即抓拍点评" : "Check Now"]);

  const dialog = el("div", {
    class: "modal-card live-coach-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "live-coach-title",
  }, [
    el("header", { class: "modal-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: isZh ? "AI 视觉实时姿态识别 & 语音伴练" : "LIVE AI VISION & VOICE FORM COACH" }),
        el("h3", { id: "live-coach-title", text: guide.displayName }),
      ]),
      el("div", { class: "live-head-actions" }, [
        personaSwitchPill({
          compact: true,
          onSwitched: () => {
            unlockCoachAudio();
            lastSpokenCue = "";
            if (isCoaching) analyzeSingleFrame();
          },
        }),
        el("button", {
          type: "button",
          class: "icon-btn",
          "aria-label": isZh ? "关闭" : "Close",
          onclick: () => { stopAll(); closeModal(); },
        }, [icon("close")]),
      ]),
    ]),
    el("div", { class: "live-coach-body" }, [
      // Camera viewport + alignment overlay
      el("div", { class: "live-video-stage" }, [
        videoEl,
        simStageWrap,
        // Alignment framing HUD
        el("div", { class: "live-hud-overlay" }, [
          el("div", { class: "live-hud-top" }, [
            statusBadge,
            el("div", { class: "live-hud-metrics" }, [scoreBadge, repBadge]),
          ]),
          el("div", { class: "live-hud-reticle", "aria-hidden": "true" }),
          el("div", { class: "live-hud-bottom" }, [
            el("span", { class: "live-tempo-hint", text: `⏱ ${guide.tempo}` }),
          ]),
        ]),
      ]),

      // Transparent AI scene observation bar
      observedSceneBar,

      // Live voice coaching transcript banner
      voiceCueBanner,

      // 3 biomechanical checkpoints
      checksWrap,

      // Control buttons
      el("div", { class: "live-controls-bar" }, [
        toggleBtn,
        snapNowBtn,
        voiceToggleBtn,
        flipCamBtn,
        demoModeBtn,
      ]),

      // Finish set & send to coach
      el("div", { class: "live-coach-foot" }, [
        el("button", {
          type: "button",
          class: "btn btn-outline btn-sm",
          onclick: () => {
            stopAll();
            closeModal();
            openExerciseDetailModal(exOrId, actions);
          },
        }, [icon("info"), isZh ? "查看动作分解要点" : "View Form Guide"]),
        el("button", {
          type: "button",
          class: "btn btn-primary btn-sm",
          onclick: () => {
            const scoreStr = lastScore ? `（AI 动作评分 ${lastScore} 分）` : "";
            const repStr = repCount > 0 ? `${repCount} 次` : "";
            stopAll();
            closeModal();
            if (actions && actions.openCoach) {
              actions.openCoach({
                send: isZh
                  ? (repCount > 0
                      ? `我刚刚跟着实时语音伴练完成了 1 组「${guide.zhName}」${repStr}${scoreStr}，帮我记录并给点建议！`
                      : `我刚打开了「${guide.zhName}」实时伴练，请告诉我做这个动作最需要注意的机位角度和发力要点，并帮我记录今天这组训练！`)
                  : (repCount > 0
                      ? `I just finished a set of ${guide.rawName} for ${repCount} reps with the Live Form Coach${lastScore ? ` (Form Score: ${lastScore})` : ""}. Please log it!`
                      : `I just practiced ${guide.rawName} with the Live Form Coach. Can you share key form tips and help me log my set?`),
              });
            }
          },
        }, [icon("check"), isZh ? "完成本组并记录训练" : "Finish Set & Log"]),
      ]),
    ]),
  ]);

  openModal(dialog);
  // Automatically stop camera if backdrop is clicked or Escape is pressed
  const obs = new MutationObserver(() => {
    if (!document.body.contains(dialog)) {
      stopAll();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Start camera and immediately kick off live voice coaching once video warms up
  startCamera().then((camOk) => {
    if (!document.body.contains(dialog)) return;
    if (camOk) {
      setTimeout(() => {
        if (document.body.contains(dialog) && !isCoaching) {
          setCoachingState(true, { speakIntro: true });
        }
      }, 450);
    } else {
      isCoaching = false;
      toggleBtn.replaceChildren(icon("play-arrow"), isZh ? "开始实时语音指导" : "Start Live Voice Coach");
    }
  });
}
