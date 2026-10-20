// Daily Science Micro-Learning Card ("每日训练/健康/营养学 Tips"):
// Bite-sized, evidence-based daily lessons across Training, Nutrition,
// Recovery, and Metabolism with streak/mastery tracking and persona commentary.
import { el, icon } from "./util.js";
import { getLang } from "./i18n.js";
import { showToast } from "./modal.js";
import { coachAvatar, getPersona, getPersonaId, speakCoachText, stopCoachSpeech, unlockCoachAudio } from "./personas.js";
import { track } from "./telemetry.js";
import { MORE_TIPS } from "./tips_more.js";

const LEARNED_KEY = "fb_tips_learned_v1";

export const TIP_CATEGORIES = [
  { id: "all", icon: "auto-awesome", zh: "全部精选", en: "All" },
  { id: "training", icon: "fitness-center", zh: "训练科学", en: "Training" },
  { id: "nutrition", icon: "restaurant", zh: "运动营养", en: "Nutrition" },
  { id: "recovery", icon: "bedtime", zh: "恢复与睡眠", en: "Recovery" },
  { id: "metabolism", icon: "local-fire-department", zh: "代谢与习惯", en: "Metabolism" },
];

const BASE_TIPS = [
  {
    id: "leucine_threshold",
    category: "nutrition",
    goals: ["muscle_gain", "recomposition", "fat_loss"],
    zh: {
      title: "亮氨酸阈值：为什么蛋白质「分餐吃」比「一顿猛炫」更有效？",
      takeaway: "单餐摄入 25–40g 优质蛋白（含约 2.5–3g 亮氨酸）即可充分触发肌肉蛋白合成（MPS）开关。",
      science: "人体肌肉蛋白合成类似「脉冲信号」而非无底洞。如果早午餐几乎不吃蛋白、晚餐一次性吃下 90g，超出单次合成上限的氨基酸更多会被氧化供能；而均匀分配到 3–4 餐，全天可触发 3–4 次合成高峰。",
      action: "检查今天的三餐：确保早餐和午餐也各有至少 25–30g 蛋白质（如 2 个鸡蛋 + 1 杯无糖希腊酸奶或 120g 鸡胸/鱼虾）。",
      personaNotes: {
        iron_leo: "别把蛋白质全堆到夜宵！早上起来第一餐就把蛋白拉满，给肌肉全天候供弹药！",
        warm_maya: "早餐加颗蛋配杯豆浆或酸奶就很好达成啦～分餐吃肠胃也更轻松舒服哦！",
        science_dr_chen: "mTORC1 通路受胞内亮氨酸浓度激活，每 3–5 小时维持一次峰值能最大化 24h 净蛋白平衡。",
      },
      askPrompt: "结合我目前的每日蛋白质目标，帮我规划一下早、中、晚三餐分别吃多少克蛋白质最合理？",
    },
    en: {
      title: "The Leucine Trigger: Why Spreading Protein Across Meals Wins",
      takeaway: "Hitting 25–40g of high-quality protein per meal (~2.5–3g leucine) flips the Muscle Protein Synthesis (MPS) switch.",
      science: "Muscle protein synthesis acts like a dimmer switch with a ceiling per meal. Eating 10g at breakfast and 90g at dinner triggers fewer synthesis pulses than eating 30–40g across 3–4 evenly spaced meals.",
      action: "Aim for at least 25–30g of protein at breakfast today (e.g., eggs + Greek yogurt or a protein shake).",
      personaNotes: {
        iron_leo: "Stop saving all your protein for dinner! Fuel those muscles right from meal one!",
        warm_maya: "Adding Greek yogurt or eggs to breakfast is such an easy, gentle way to stay energized all morning!",
        science_dr_chen: "Intracellular leucine activates mTORC1; 3–4 boluses spaced 3–5h apart maximize 24h myofibrillar synthesis.",
      },
      askPrompt: "Based on my daily protein target, how should I split my protein grams across breakfast, lunch, and dinner?",
    },
  },
  {
    id: "neat_hidden_burn",
    category: "metabolism",
    goals: ["fat_loss", "recomposition", "general_fitness"],
    zh: {
      title: "NEAT 非运动消耗：决定减脂成败的「隐形热量引擎」",
      takeaway: "日常步行、站立、做家务等非运动消耗（NEAT）占全天总消耗的 15%–30%，远超普通人一节健身课！",
      science: "研究发现，当人体处于热量缺口或高强度训练后，大脑会潜意识让你减少日常走动（「代谢补偿」），导致少消耗 200–400 kcal，抵消了运动成果。维持稳定的日常步数是防平台期的最强武器。",
      action: "今天每工作 1 小时起身走动 3 分钟，或者午饭/晚饭后散步 15 分钟，多攒下 2000 步轻松消耗约 80–100 kcal。",
      personaNotes: {
        iron_leo: "练完1小时然后瘫坐10小时可不行！饭后迈开腿走起来，让脂肪全天持续燃烧！",
        warm_maya: "晚饭后戴上耳机散步 15 分钟，既助消化又能放松心情，不知不觉就多消耗好多热量呢～",
        science_dr_chen: "热量限制期下丘脑会下调自发躯体活动（SPA），固定每日步数基准可有效阻断适应性生热下降。",
      },
      askPrompt: "在减脂期如何利用 NEAT（非运动消耗）突破体重平台期？给我几个好执行的日常小习惯。",
    },
    en: {
      title: "NEAT: The Hidden Calorie Engine Behind Effortless Fat Loss",
      takeaway: "Non-Exercise Activity Thermogenesis (walking, standing, fidgeting) accounts for 15%–30% of daily energy burn—often more than your gym session.",
      science: "When you diet or train hard, your brain subconsciously reduces spontaneous movement to conserve energy, quietly erasing 200–400 kcal of your deficit. Keeping daily steps steady prevents plateaus.",
      action: "Take a 12-minute brisk walk after lunch or dinner today to add ~1,500 effortless steps.",
      personaNotes: {
        iron_leo: "Crushing a 45-minute workout doesn't mean sitting like a statue the other 23 hours—keep moving!",
        warm_maya: "A relaxing evening walk with your favorite podcast is the kindest, easiest fat-loss habit you can build!",
        science_dr_chen: "Caloric restriction downregulates spontaneous physical activity; clamping step count preserves your true TDEE.",
      },
      askPrompt: "How can I use NEAT and daily steps to keep my fat loss moving without adding extra cardio fatigue?",
    },
  },
  {
    id: "eccentric_hypertrophy",
    category: "training",
    goals: ["muscle_gain", "recomposition", "general_fitness"],
    zh: {
      title: "离心控制：为什么「慢速下放」能让训练效果翻倍？",
      takeaway: "把器械「放回去」的离心阶段控制在 2–3 秒，不仅能大幅提升肌肥大刺激，还能减少 50% 以上的关节冲击。",
      science: "肌肉在被拉长状态下对抗阻力（离心收缩）时，单个肌横桥承受的机械张力高于向心阶段，且更容易募集高阈值快肌纤维。自由落体式下放不仅浪费了一半的训练收益，还容易让肌腱承受瞬间剪切力。",
      action: "今天训练时，试着在心里默念「1-2-下放，1-推起」节奏，尤其注意深蹲下蹲、卧推下放和划船还原阶段。",
      personaNotes: {
        iron_leo: "是你控制铁，不是铁砸你！下放给我稳稳撑住 2 秒，感受肌纤维被彻底拉满！",
        warm_maya: "把下放速度放慢一点点，你会发现不用盲目加重量，目标肌肉的酸胀感反而更清晰更安全哦～",
        science_dr_chen: "肌联蛋白（Titin）在受控离心拉伸中提供被动刚度，显著增强机械转导信号与肌节串联生长。",
      },
      askPrompt: "我目前的训练计划里，哪些动作最需要注意离心控制？具体的节奏（Tempo）应该怎么安排？",
    },
    en: {
      title: "Eccentric Control: Why Slowing the Lowering Phase Doubles Your Gains",
      takeaway: "Taking 2–3 controlled seconds to lower the weight maximizes mechanical tension and protects your joints.",
      science: "Muscles produce higher force per motor unit during eccentric (lengthening) contractions. Dropping weights with gravity throws away half of every rep's hypertrophy stimulus and spikes tendon shear stress.",
      action: "Use a '2-second lower, 1-second pause, crisp drive' tempo on your main compound movement today.",
      personaNotes: {
        iron_leo: "You control the iron—never let gravity do the work for you! Own every inch of the negative!",
        warm_maya: "Slowing down the lowering phase helps you connect with your muscles using lighter, joint-friendly weights!",
        science_dr_chen: "Titin-mediated passive tension during controlled eccentrics amplifies mechanotransduction and sarcomerogenesis.",
      },
      askPrompt: "Which exercises in my current training plan benefit most from a 3-second eccentric tempo?",
    },
  },
  {
    id: "sleep_partitioning",
    category: "recovery",
    goals: ["fat_loss", "muscle_gain", "recomposition", "general_fitness"],
    zh: {
      title: "睡眠与热量分配：少睡 2 小时，减掉的为什么全是肌肉？",
      takeaway: "同样处于热量缺口，睡够 7.5–8 小时的人减掉的大多是纯脂肪；而只睡 5.5 小时的人，瘦体重流失会增加 60%！",
      science: "经典的芝加哥大学代谢对照实验证实：睡眠不足会使皮质醇升高、胰岛素敏感性下降 30%，并使饥饿素（Ghrelin）飙升，身体会进入「保脂拆肌」模式，同时第二天对高糖高脂食物的渴望显著增强。",
      action: "今晚提前 30 分钟把手机调成深色/勿扰模式，保证至少 7 小时高质量睡眠——这是性价比最高的「增肌减脂补剂」。",
      personaNotes: {
        iron_leo: "肌肉不是在健身房长出来的，是在深睡眠里修复长大的！今晚准时关灯睡觉也是硬核自律！",
        warm_maya: "好好睡一觉真的是对身体最温柔也最有效的奖励～今晚早点放下手机，睡个美容恢复觉吧！",
        science_dr_chen: "Nedeltcheva 等人的随机交叉试验表明：5.5h 睡眠组脂肪氧化率显著降低，非脂肪组织分解比例激增 60%。",
      },
      askPrompt: "如果前一天晚上没睡好（少于6小时），今天的训练强度和饮食应该怎么动态调整最安全？",
    },
    en: {
      title: "Sleep & Nutrient Partitioning: Why Short Sleep Costs Muscle, Not Fat",
      takeaway: "In the same calorie deficit, sleeping 8 hours vs. 5.5 hours shifts weight loss strongly toward pure fat while preserving muscle.",
      science: "Controlled metabolic ward studies show sleep restriction elevates cortisol, impairs insulin sensitivity by ~30%, spikes ghrelin (hunger hormone), and increases lean-mass loss by up to 60%.",
      action: "Set a wind-down alarm 30 minutes before bed tonight to lock in 7.5+ hours of restorative sleep.",
      personaNotes: {
        iron_leo: "You don't grow in the gym—you grow when you sleep! Treat your 8 hours like a mandatory training set!",
        warm_maya: "Rest is productive too! Giving yourself an extra 30 minutes of sleep tonight is the sweetest boost for your progress.",
        science_dr_chen: "Slow-wave sleep drives pulsatile GH release and preserves myofibrillar protein balance during energy deficits.",
      },
      askPrompt: "If I slept poorly last night (<6 hours), how should I adjust my workout intensity and nutrition today?",
    },
  },
  {
    id: "rpe_autoregulation",
    category: "training",
    goals: ["muscle_gain", "recomposition", "fat_loss", "general_fitness"],
    zh: {
      title: "RPE 7–8 黄金法则：不必每组练到力竭也能高效进步",
      takeaway: "把大多数工作组控制在 RPE 8（保留 2 次余力，即 RIR 2），既能获得 95% 以上的刺激，又不会拖垮神经恢复。",
      science: "运动科学表明，距离力竭最后 5 次重复（Effective Reps）提供主要的肌肥大刺激，而真正做到彻底力竭（RPE 10）会让中枢神经系统（CNS）与肌膜损伤恢复时间翻倍，导致下一节训练质量下降。",
      action: "今天做主项复合动作（如深蹲、卧推、硬拉）时，在动作刚明显变慢、还能标准再做 2 次时停下，把完美姿态留给下一组。",
      personaNotes: {
        iron_leo: "聪明地狠练！主项留 1–2 个保底确保动作不变形，孤立小肌群最后一组再冲极限！",
        warm_maya: "原来不需要每次都练到精疲力尽也能变强呀～留两下余力，第二天身体依然轻盈有活力！",
        science_dr_chen: "RPE 8（2 RIR）可募集绝大部分高阈值运动单位，同时将神经肌肉疲劳控制在 48 小时恢复窗口内。",
      },
      askPrompt: "在日常训练中，我该怎么凭感觉准确判断自己是不是到了 RPE 8（保留 2 次余力）？",
    },
    en: {
      title: "The RPE 8 Sweet Spot: Why Leaving 2 Reps in Reserve Builds More Long-Term Strength",
      takeaway: "Stopping most working sets at RPE 8 (2 Reps in Reserve) captures ~95% of the stimulus with half the recovery cost of true failure.",
      science: "Pushing compound lifts to absolute failure (RPE 10) exponentially increases central nervous system fatigue and muscle damage, hurting your performance for the rest of the week.",
      action: "Finish your compound sets today when bar/movement speed noticeably slows and you know you have 2 clean reps left.",
      personaNotes: {
        iron_leo: "Train hard AND smart! Leave 1–2 clean reps in the tank on big lifts so every rep looks textbook!",
        warm_maya: "You don't have to exhaust yourself to see amazing results—stopping 2 reps shy of failure keeps training sustainable!",
        science_dr_chen: "At 2 RIR, high-threshold motor units are fully recruited while limiting excitation-contraction coupling fatigue.",
      },
      askPrompt: "How can I accurately judge RPE 7–8 during my sets, and when is it okay to go closer to failure?",
    },
  },
  {
    id: "tef_satiety",
    category: "nutrition",
    goals: ["fat_loss", "recomposition", "general_fitness"],
    zh: {
      title: "食物热效应 (TEF)：吃对食材，连消化都在帮你多消耗热量",
      takeaway: "身体消化蛋白质需要消耗其本身热量的 20%–30%，而消化脂肪仅消耗 0%–3%！",
      science: "同样是摄入 100 kcal：如果是鸡胸肉或鱼虾，身体光把氨基酸拆解吸收就要花掉 25 kcal，净吸收仅约 75 kcal；而且高蛋白+高膳食纤维能显著刺激 GLP-1 和 PYY 饱腹激素分泌，自然抑制嘴馋。",
      action: "今天下午如果容易饿，把饼干/奶茶换成「1 杯无糖酸奶 + 1 小把蓝莓/坚果」或「卤蛋白/毛豆」，饱腹感可持续 3 小时以上。",
      personaNotes: {
        iron_leo: "选对天然高蛋白食材，连你的肠胃都在替你做有氧！",
        warm_maya: "减脂千万别硬饿肚子呀～换成高蛋白加高纤维的小加餐，吃得饱饱的也能稳稳瘦！",
        science_dr_chen: "蛋白质的氨基酸脱氨基与尿素合成属高耗能过程（TEF 20–30%），并能协同提升内源性 GLP-1 水平。",
      },
      askPrompt: "推荐几种适合上班族/外食党随手买到的高食物热效应、高饱腹感加餐组合？",
    },
    en: {
      title: "Thermic Effect of Food (TEF): Burn More Calories Just by Digesting",
      takeaway: "Your body burns 20%–30% of protein's calories just digesting and processing it, compared to only 0%–3% for dietary fat.",
      science: "Out of 100 kcal of lean protein, only ~75 kcal net is absorbed after digestion costs. Protein and fiber also stimulate GLP-1 and PYY satiety hormones to keep cravings away for hours.",
      action: "Start your lunch and dinner today by eating your protein and vegetables first before refined starches.",
      personaNotes: {
        iron_leo: "Make your metabolism work harder! Lean protein + fiber turns every meal into a metabolic advantage!",
        warm_maya: "Eating protein and colorful veggies first keeps your blood sugar steady and afternoon cravings away!",
        science_dr_chen: "Deamination and peptide bond turnover yield a 20–30% thermic effect while blunting postprandial glycemic spikes.",
      },
      askPrompt: "What are some convenient, high-satiety snack ideas that pack 20g+ protein under 200 kcal?",
    },
  },
  {
    id: "scale_water_noise",
    category: "metabolism",
    goals: ["fat_loss", "recomposition", "muscle_gain", "general_fitness"],
    zh: {
      title: "为什么昨晚吃顿咸的，今早体重飙升 1.5kg？别慌，那不是脂肪！",
      takeaway: "要长出 1kg 纯脂肪需要额外多摄入约 7700 kcal！单日 0.5–1.5kg 的体重起伏 95% 都是水分与肌糖原波动。",
      science: "每储存 1g 碳水化合物（糖原）会锁住 3–4g 水分；高钠外食会让细胞外液暂时潴留；甚至一次高强度腿部训练引起的肌肉微炎症水肿也会让体重短暂上升 1kg（恰恰说明肌肉正在修复生长！）。",
      action: "永远只看「7 天移动平均体重」趋势线（在「进度」页查看），不要被单日晨重数字绑架情绪。",
      personaNotes: {
        iron_leo: "一顿饭长不出两斤肥肉！稳住心态，多喝水排钠，按原计划继续开练！",
        warm_maya: "看到体重秤突然跳一下千万别责怪自己呀～那只是身体暂时多抱了一点水，两天就自然消退啦！",
        science_dr_chen: "1g 肌糖原结合约 3g 水分子，钠离子渗透压平衡需 24–48h 肾脏排泄恢复，7日指数移动平均可滤除高频噪声。",
      },
      askPrompt: "帮我看看我最近的体重趋势，单日波动正常吗？7天移动平均线目前是什么走向？",
    },
    en: {
      title: "Why Your Weight Jumped 1.5 kg Overnight (Spoiler: It's Water, Not Fat)",
      takeaway: "Gaining 1 kg of actual body fat requires ~7,700 excess kcal. Overnight weight spikes are almost entirely water, glycogen, and sodium.",
      science: "Every gram of stored carbohydrate binds 3–4g of water, salty meals temporarily hold extracellular fluid, and hard leg workouts cause healthy muscle repair inflammation (water retention).",
      action: "Judge your progress strictly by the 7-day moving average line on the Progress tab—never a single morning weigh-in.",
      personaNotes: {
        iron_leo: "Ignore the daily scale noise! Hydrate, stick to the plan, and watch the 7-day trend drop!",
        warm_maya: "Never let one morning's scale number steal your joy—water fluctuations are completely normal and temporary!",
        science_dr_chen: "Glycogen-bound water (1:3–4 ratio) and sodium osmolality create ±1.5 kg daily variance; moving averages isolate true tissue change.",
      },
      askPrompt: "Can you analyze my recent weight trend and moving average to tell me how my real progress looks?",
    },
  },
  {
    id: "rest_intervals_science",
    category: "training",
    goals: ["muscle_gain", "recomposition", "fat_loss"],
    zh: {
      title: "组间休息不是越短越好：多歇 1 分钟，增肌塑形效果反而更好？",
      takeaway: "复合动作（深蹲、卧推、划船）组间休息 90–150 秒，比只歇 45 秒能多完成 20% 以上的有效训练容量！",
      science: "磷酸肌酸（ATP-CP）系统恢复 85% 以上需要约 90–120 秒。如果为了追求「暴汗气喘」只休息 30–45 秒，下一组因为心肺和局部代谢物堆积被迫大幅降重或少做 4 次，反而削弱了对肌肉的机械张力刺激。",
      action: "今天做大肌群复合动作时，安心休息够 90–120 秒，在呼吸平复后再高质量开启下一组。",
      personaNotes: {
        iron_leo: "练力量不是跑马拉松！组间给我喘匀气、恢复满血，下一组才能推起真重量！",
        warm_maya: "组间安心休息一分半钟、喝口水深呼吸，不用急吼吼赶下一组，动作质量会高很多哦～",
        science_dr_chen: "Schoenfeld 等人的对照研究表明，2–3 分钟组间休息相比 1 分钟组显著提升总训练吨位与股四头肌横截面积增长。",
      },
      askPrompt: "针对我目前的训练计划，主项复合动作和辅助小动作分别休息多少秒最科学？",
    },
    en: {
      title: "Why Resting Longer Between Sets Actually Builds More Muscle",
      takeaway: "Resting 90–150 seconds on compound lifts lets you maintain higher volume and mechanical tension than rushing 45-second breaks.",
      science: "Replenishing ~85% of intramuscular phosphocreatine (ATP-CP) takes 90–120 seconds. Cutting rest too short turns strength training into cardio and forces your reps to drop prematurely.",
      action: "Give yourself a full 90–120 seconds between compound sets today so every set stays strong.",
      personaNotes: {
        iron_leo: "Strength training isn't a sprint race! Recover your power between sets so you can move real weight!",
        warm_maya: "Give yourself permission to catch your breath between sets—quality reps always beat rushed reps!",
        science_dr_chen: "Phosphocreatine resynthesis follows a biphasic curve requiring ~120s to sustain high-threshold motor unit output.",
      },
      askPrompt: "How long should I rest between sets for my main exercises versus my accessory/core movements?",
    },
  },
];

function getLearnedState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LEARNED_KEY) || "{}");
    return {
      ids: Array.isArray(raw.ids) ? raw.ids : [],
      lastDate: raw.lastDate || "",
      streak: Number(raw.streak) || 0,
    };
  } catch {
    return { ids: [], lastDate: "", streak: 0 };
  }
}

function markTipLearned(tipId, todayIso) {
  const st = getLearnedState();
  const set = new Set(st.ids);
  const isNew = !set.has(tipId);
  set.add(tipId);

  let streak = st.streak || 0;
  if (todayIso && st.lastDate !== todayIso) {
    if (st.lastDate) {
      const diffDays = Math.round((Date.parse(todayIso) - Date.parse(st.lastDate)) / 86400000);
      streak = diffDays === 1 ? streak + 1 : 1;
    } else {
      streak = 1;
    }
  } else if (!streak) {
    streak = 1;
  }

  const next = { ids: [...set], lastDate: todayIso || st.lastDate, streak };
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return { ...next, isNew };
}

export const DAILY_TIPS = [...BASE_TIPS, ...MORE_TIPS];

const TIP_OF_DAY_KEY = "fb_tip_of_day_v1";

function localIsoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayNumber(iso) {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

/** Tips ordered for this user: goal-relevant first, then the rest (stable order). */
function orderedTips(pool, goal) {
  const relevant = pool.filter((t) => (t.goals || []).includes(goal));
  const rest = pool.filter((t) => !(t.goals || []).includes(goal));
  return [...relevant, ...rest];
}

/**
 * Today's tip, pinned for the whole day (marking it learned does not swap it).
 * A new day moves to the next tip in a stable rotation, skipping tips the user
 * already learned (until all are learned) and never repeating yesterday's tip.
 */
export function pickTipOfDay(todayIso, goal, learnedIds = [], pool = DAILY_TIPS) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TIP_OF_DAY_KEY) || "null"); } catch { saved = null; }
  if (saved && saved.date === todayIso) {
    const pinned = pool.find((t) => t.id === saved.id);
    if (pinned) return pinned;
  }
  const order = orderedTips(pool, goal);
  const learned = new Set(learnedIds);
  const yesterday = saved && saved.date !== todayIso ? saved.id : null;
  const start = ((dayNumber(todayIso) % order.length) + order.length) % order.length;
  const rotated = [...order.slice(start), ...order.slice(0, start)];
  const candidates = rotated.filter((t) => t.id !== yesterday);
  const tip = candidates.find((t) => !learned.has(t.id)) || candidates[0] || order[0];
  try { localStorage.setItem(TIP_OF_DAY_KEY, JSON.stringify({ date: todayIso, id: tip.id })); } catch { /* ignore */ }
  return tip;
}

/**
 * Renders the interactive "每日科学微课堂 (Daily Science Lab)" card on #today.
 */
export function dailyScienceCard(d, actions) {
  const lang = getLang();
  const isZh = lang === "zh";
  // The dashboard can be a cached copy from yesterday; never go back in time.
  const localToday = localIsoDate();
  const todayIso = d && d.today && d.today > localToday ? d.today : localToday;
  const userGoal = (d && d.profile && d.profile.goal) || (d && d.plan && d.plan.goal) || "general_fitness";

  let activeCategory = "all";
  let offset = 0;

  const container = el("section", {
    class: "card science-tip-card",
    "aria-label": isZh ? "每日科学微课堂" : "Daily Science Tip",
  });

  const paint = () => {
    const filtered = activeCategory === "all"
      ? DAILY_TIPS
      : DAILY_TIPS.filter((item) => item.category === activeCategory);
    const pool = orderedTips(filtered.length ? filtered : DAILY_TIPS, userGoal);
    const dailyTip = pickTipOfDay(todayIso, userGoal, getLearnedState().ids);
    // "All" starts on today's pinned tip; a category tab starts on that category's
    // tip for today. "Next tip" walks the same stable order.
    const startIdx = activeCategory === "all"
      ? Math.max(0, pool.findIndex((t) => t.id === dailyTip.id))
      : ((dayNumber(todayIso) % pool.length) + pool.length) % pool.length;
    const baseIdx = startIdx;
    const currentTip = pool[(baseIdx + offset) % pool.length];
    const copy = currentTip[isZh ? "zh" : "en"];
    const catMeta = TIP_CATEGORIES.find((c) => c.id === currentTip.category) || TIP_CATEGORIES[0];

    const personaId = getPersonaId();
    const persona = getPersona(personaId, lang);
    const personaNote = (copy.personaNotes && copy.personaNotes[personaId]) || "";

    const learnedState = getLearnedState();
    const isLearned = learnedState.ids.includes(currentTip.id);

    container.replaceChildren(
      // Top header: title + mastery badge + persona switcher
      el("div", { class: "science-tip-head" }, [
        el("div", { class: "science-tip-title-wrap" }, [
          el("span", { class: "science-tip-icon", "aria-hidden": "true" }, [icon("auto-awesome", { fill: true })]),
          el("div", {}, [
            el("div", { class: "science-eyebrow-row" }, [
              el("span", { class: "eyebrow accent", text: (() => {
                const [, mm, dd] = todayIso.split("-").map(Number);
                return isZh ? `每日科学微课堂 · ${mm}月${dd}日` : `DAILY SCIENCE · ${new Date(todayIso + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" })}`;
              })() }),
              el("span", {
                class: "pill pill-outline science-cat-pill",
                text: isZh ? catMeta.zh : catMeta.en,
              }),
            ]),
            el("h3", { class: "science-tip-headline", text: copy.title }),
          ]),
        ]),
        el("div", { class: "science-head-right" }, [
          el("span", {
            class: "pill pill-primary science-streak-pill",
            title: isZh ? "累计已学知识卡片与连续打卡天数" : "Mastered tips & learning streak",
            text: isZh
              ? `已学 ${learnedState.ids.length}/${DAILY_TIPS.length}${learnedState.streak ? ` · 🔥${learnedState.streak}天` : ""}`
              : `${learnedState.ids.length}/${DAILY_TIPS.length} Learned${learnedState.streak ? ` · 🔥${learnedState.streak}d` : ""}`,
          }),
        ]),
      ]),

      // Category filter strip
      el("div", { class: "science-cat-tabs", role: "tablist" }, TIP_CATEGORIES.map((c) =>
        el("button", {
          type: "button",
          role: "tab",
          "aria-selected": c.id === activeCategory ? "true" : "false",
          class: `science-cat-tab${c.id === activeCategory ? " active" : ""}`,
          onclick: () => {
            activeCategory = c.id;
            offset = 0;
            track("tip_interact", { action: "filter_category", category: c.id });
            paint();
          },
        }, [icon(c.icon), el("span", { text: isZh ? c.zh : c.en })])
      )),

      // 3-part micro-lesson body
      el("div", { class: "science-tip-body" }, [
        el("div", { class: "science-takeaway-box" }, [
          el("span", { class: "science-box-label", text: isZh ? "💡 核心结论" : "💡 Key Takeaway" }),
          el("p", { class: "science-takeaway-text", text: copy.takeaway }),
        ]),
        el("div", { class: "science-grid-2" }, [
          el("div", { class: "science-subbox" }, [
            el("span", { class: "science-box-label muted", text: isZh ? "🔬 科学原理 (Why It Works)" : "🔬 Why It Works" }),
            el("p", { class: "muted small", text: copy.science }),
          ]),
          el("div", { class: "science-subbox action-highlight" }, [
            el("span", { class: "science-box-label accent", text: isZh ? "🎯 今日微行动 (Action Step)" : "🎯 Today's Micro-Action" }),
            el("p", { class: "small", text: copy.action }),
          ]),
        ]),
        personaNote ? el("div", { class: `science-persona-bar ${persona.accentClass}` }, [
          el("div", { class: "science-persona-note" }, [
            coachAvatar(personaId, { size: "sm" }),
            el("p", { class: "small" }, [
              el("strong", { text: `${persona.copy.tipPrefix} ` }),
              el("span", { text: personaNote }),
            ]),
          ]),
          el("div", { class: "science-persona-actions" }, [
            (() => {
              let tipPlaying = false;
              const ttsBtn = el("button", {
                type: "button",
                class: "icon-btn science-tts-btn",
                title: isZh ? "语音朗读本条微课堂" : "Listen to this tip",
                onclick: async () => {
                  unlockCoachAudio();
                  if (tipPlaying) {
                    tipPlaying = false;
                    ttsBtn.classList.remove("is-playing");
                    stopCoachSpeech();
                    return;
                  }
                  tipPlaying = true;
                  ttsBtn.classList.add("is-playing");
                  track("tip_interact", { action: "tts_tip", tip_id: currentTip.id });
                  await speakCoachText(`${personaNote} ${copy.takeaway}`, {
                    personaId,
                    lang,
                    onEnd: () => {
                      tipPlaying = false;
                      ttsBtn.classList.remove("is-playing");
                    },
                  });
                },
              }, [icon("volume-up")]);
              return ttsBtn;
            })(),
          ]),
        ]) : null,
      ]),

      // Footer actions: Mark learned, Next tip, Ask Coach
      el("div", { class: "science-tip-foot" }, [
        el("div", { class: "science-foot-left" }, [
          el("button", {
            type: "button",
            class: `btn ${isLearned ? "btn-primary" : "btn-outline"} btn-sm`,
            onclick: () => {
              const res = markTipLearned(currentTip.id, todayIso);
              track("tip_interact", { action: "mark_learned", tip_id: currentTip.id });
              paint();
              if (res.isNew) {
                showToast(
                  isZh
                    ? `🎉 已打卡学习！累计掌握 ${res.ids.length}/${DAILY_TIPS.length} 条科学锦囊`
                    : `🎉 Marked as learned! (${res.ids.length}/${DAILY_TIPS.length} mastered)`
                );
              }
            },
          }, [
            icon(isLearned ? "check-circle" : "check"),
            isZh ? (isLearned ? "今日已学 ✓" : "打卡已学") : (isLearned ? "Learned ✓" : "Mark Learned"),
          ]),
          el("button", {
            type: "button",
            class: "btn btn-outline btn-sm",
            onclick: () => {
              offset = (offset + 1) % pool.length;
              track("tip_interact", { action: "next_tip", tip_id: pool[(baseIdx + offset) % pool.length].id });
              paint();
            },
          }, [icon("refresh"), isZh ? "换一条学学" : "Next Tip"]),
        ]),
        el("button", {
          type: "button",
          class: "link-btn",
          onclick: () => {
            track("tip_interact", { action: "ask_coach", tip_id: currentTip.id });
            if (actions && actions.openCoach) {
              actions.openCoach({ send: copy.askPrompt });
            }
          },
        }, [isZh ? "结合我的情况问教练" : "Ask Coach How to Apply", icon("arrow-forward")]),
      ]),
    );
  };

  paint();
  return container;
}
