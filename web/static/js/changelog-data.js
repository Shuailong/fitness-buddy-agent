// What's new: user-facing release notes, newest first. Shown on /changelog and
// used by the app to badge "new" until the user has seen the latest entry.
// Add an entry at the top for every user-visible change (keep ids unique and
// increasing: YYYY-MM-DD plus a letter when there are several in a day).
export const CHANGELOG = [
  {
    id: "2026-10-26a",
    date: "2026-10-26",
    title: { zh: "对话体验升级", en: "A smoother chat" },
    items: [
      { type: "new", zh: "回复过程中发送键会变成「停止」，随时可以停下；一次只回复一条，不会再排队卡住。", en: "While the coach replies, Send becomes Stop - stop any time. One reply at a time, so nothing gets stuck in a queue." },
      { type: "new", zh: "网络断了或切到后台，回来后回复会接着显示，不用重发；重新打开 App 也能看到还在生成的回复。", en: "If the connection drops or you switch apps, the reply continues where it left off when you're back - even after reopening the app." },
      { type: "new", zh: "最新一条消息可以「编辑」后重新发送，旧版本会淡化保留；出错时可以一键「重试」。", en: "Edit and resend your latest message (the old version stays, dimmed), and retry with one tap when something goes wrong." },
      { type: "improved", zh: "思考过程改为一行流动的文字，显示教练正在做什么，点开可看全部步骤；启动画面动画更顺滑。", en: "The thinking indicator is now one flowing line showing what the coach is doing (tap for all steps), and the launch animation is smoother." },
    ],
  },
  {
    id: "2026-10-23d",
    date: "2026-10-23",
    title: { zh: "全屏实时纠错", en: "Full-screen live coaching" },
    items: [
      { type: "improved", zh: "实时摄像头纠错改为全屏：画面铺满屏幕，次数和评分大字显示，教练提示放在底部、读起来更清楚；常用按钮集中在拇指可及的位置，横屏也能用。", en: "The live camera coach is now full screen: the camera fills the display, reps and score are big and clear, coach cues sit at the bottom, and the main controls are within thumb reach - in portrait or landscape." },
      { type: "improved", zh: "看不到全身时会显示取景框提示你站到合适的位置；训练时屏幕保持常亮。", en: "A framing guide shows where to stand until your whole body is in view, and the screen stays awake while you train." },
    ],
  },
  {
    id: "2026-10-23c",
    date: "2026-10-23",
    title: { zh: "实时纠错更省电", en: "Lighter live coaching" },
    items: [
      { type: "improved", zh: "实时摄像头纠错改为约每 4 秒分析一次动作，更省流量和电量；每天可用约 40 分钟，用完后第二天恢复。", en: "The live camera coach now checks your form about every 4 seconds, using less data and battery; about 40 minutes a day are included, renewed daily." },
    ],
  },
  {
    id: "2026-10-23b",
    date: "2026-10-23",
    title: { zh: "动作演示全面重做", en: "Rebuilt exercise guides" },
    items: [
      { type: "fixed", zh: "50 个动作的要点、常见错误、呼吸、节奏和目标肌群都改为逐个编写：提踵、腿弯举、弯举、悬垂举膝、有氧和拉伸等动作不再显示别的动作的内容。", en: "All 50 exercises now have their own cues, common mistakes, breathing, tempo and target muscles - calf raises, leg curls, curls, hanging knee raises, cardio and stretches no longer borrow another exercise's guide." },
      { type: "new", zh: "新增「调整难度」和「安全提示」；火柴人动画扩展到 40 多种动作，有氧动作循环播放，静态动作显示保持姿势。", en: "New “easier / harder” options and safety notes; stick-figure animations now cover 40+ movements, with looping cardio and steady holds." },
      { type: "improved", zh: "动作名跟随 App 语言显示；不在动作库里的动作会给出通用要点，而不是套用错误的内容。实时摄像头纠错也会按具体动作检查关键点。", en: "Exercise names follow the app language; exercises outside the library get general tips instead of a wrong guide. The live camera coach now checks each exercise's own key points." },
    ],
  },
  {
    id: "2026-10-23a",
    date: "2026-10-23",
    title: { zh: "语言更一致", en: "Consistent language" },
    items: [
      { type: "improved", zh: "新记录的饮食食物名、训练计划标题和备注会跟随 App 语言（只拍照不打字也一样）；之前已保存的记录保持原样。", en: "New meal item names, plan titles and notes now follow the app language - even for photo-only logs. Existing records stay as they were." },
      { type: "improved", zh: "出错提示也会按当前语言显示。", en: "Error messages now appear in your chosen language." },
    ],
  },
  {
    id: "2026-10-21e",
    date: "2026-10-21",
    title: { zh: "训练记录回看", en: "Workout log" },
    items: [
      { type: "new", zh: "「进展」页新增训练记录：每次实际练了哪些动作、几组几次、重量、感受和备注，一目了然；还会标出是否按计划完成。", en: "New workout log on Progress: every session's exercises, sets × reps, loads, effort and notes - marked as planned, partly planned or extra." },
      { type: "new", zh: "点开一次训练可以和当天计划逐项对比，也能一键让教练点评或修改记录；计划页已完成的日子可直接「查看实际训练」。", en: "Open a session to compare it with that day's plan, ask the coach for feedback or a correction; on Plan, completed days have “See what I did”." },
      { type: "improved", zh: "打开 App 时不再自动请求麦克风权限，第一次按住说话时才会询问。", en: "The app no longer asks for the microphone on launch - only on your first hold-to-talk." },
    ],
  },
  {
    id: "2026-10-21d",
    date: "2026-10-21",
    title: { zh: "训练和饮食提醒", en: "Training & meal reminders" },
    items: [
      { type: "new", zh: "在「设置 → 提醒」开启通知：训练日早上 8 点提醒你今天练什么，晚上 8 点还没记录饮食时提醒你拍一张。已经完成的就不打扰。", en: "Turn on notifications in Settings → Reminders: a training-day nudge at 8:00 and a meal-logging reminder at 20:00 if nothing is logged - skipped when you've already done it." },
      { type: "improved", zh: "iPhone 需先添加到主屏幕再开启提醒（iOS 的限制）。", en: "On iPhone, add the app to your Home Screen first (an iOS requirement)." },
    ],
  },
  {
    id: "2026-10-21c",
    date: "2026-10-21",
    title: { zh: "更清爽的导航", en: "A cleaner layout" },
    items: [
      { type: "improved", zh: "底部只保留「今天 / 进展 / 计划」三个页面；教练变成右下角的悬浮头像，任何页面点一下就能聊。", en: "The bottom bar now has just Today, Progress and Plan; your coach is a floating button you can open from any page." },
      { type: "improved", zh: "点右上角头像进入设置；设置页精简为常用项，其余收进「更多」。", en: "Tap your avatar for Settings - everyday options up top, the rest under “More”." },
      { type: "new", zh: "教练悬浮按钮可以拖到任意位置（松手后自动贴边，会记住位置）；聊天页像原生 App 一样从下方滑出，下拉顶部即可收起。", en: "Drag the coach button anywhere (it snaps to the edge and remembers its spot); the chat slides up like a native sheet - pull the header down to close." },
      { type: "new", zh: "往上翻看历史时，新消息不会再把你拉回底部；点「回到最新」一键回到最新对话。", en: "Reading older messages? New replies no longer yank you down - tap “Latest” to jump back." },
      { type: "fixed", zh: "修复 iPhone 桌面 App 底部的黑边。", en: "Fixed the empty band at the bottom of the iPhone home-screen app." },
    ],
  },
  {
    id: "2026-10-21b",
    date: "2026-10-21",
    title: { zh: "免登录体验 & 离线可用", en: "Try without signing in & works offline" },
    items: [
      { type: "new", zh: "首页新增「免登录体验」：带示例数据的体验账号，打开就能和教练聊天、拍照记餐、看计划（每天有用量上限，24 小时后自动删除）。", en: "“Try it without signing in” on the home page: a demo account with sample data so you can chat with the coach, log meals and see a plan right away (daily limits; deleted after 24 hours)." },
      { type: "new", zh: "离线也能打开：断网时显示上次同步的计划、数据和对话，不会再被退回登录页。", en: "Opens offline: shows your last synced plan, stats and conversation instead of the sign-in page." },
      { type: "new", zh: "离线时打的字会存为「联网后发送」，恢复网络后自动发给教练。", en: "Messages typed offline are queued and sent to your coach automatically when you're back online." },
      { type: "new", zh: "新增本页「更新日志」，有新功能时菜单会出现提示。", en: "This “What's new” page; the menu shows a dot when there's something new." },
    ],
  },
  {
    id: "2026-10-21a",
    date: "2026-10-21",
    title: { zh: "改一天的训练，几秒搞定", en: "Change a single day in seconds" },
    items: [
      { type: "new", zh: "只想改今天？跟教练说「今天只有 20 分钟」「今天累了想拉伸」「把今天挪到明天」，几秒就改好，计划页和今天页立刻更新。", en: "Just today? Tell the coach “only 20 minutes today”, “I'm tired, make it a stretch day” or “move today to tomorrow” - done in seconds, and the Plan and Today pages update right away." },
      { type: "new", zh: "被调整的那天会标「已调整」，写明原因，一键「恢复原计划」。", en: "Adjusted days are marked “Adjusted” with the reason and a one-tap “Back to original”." },
      { type: "improved", zh: "想以后每周都这样改（如「以后周二都把平板支撑换成死虫」），确认一次即可；改完当天，教练会看看后面几天要不要跟着调整。", en: "Want it every week (e.g. “swap planks for dead bugs every Tuesday”)? Confirm once. After a change, the coach checks whether the next days need adjusting too." },
      { type: "improved", zh: "教练现在准确知道今天是几号、星期几。", en: "The coach now always knows today's date and weekday." },
      { type: "fixed", zh: "修复：有一张没处理的确认卡时，之后的消息会没有回复。", en: "Fixed: messages got no reply while an unanswered confirmation card was pending." },
      { type: "fixed", zh: "修复：回复过程中切出 App 再回来，回复丢失或出现重复的确认卡。", en: "Fixed: replies lost, or duplicate confirmation cards, after switching away from the app mid-reply." },
    ],
  },
  {
    id: "2026-10-20c",
    date: "2026-10-20",
    title: { zh: "像微信一样发语音", en: "Voice messages, WeChat style" },
    items: [
      { type: "new", zh: "按住说话，松开发送；上滑取消，或滑到「转文字」先看一眼再发。", en: "Hold to talk, release to send; slide up to cancel, or slide to “To text” to check before sending." },
      { type: "improved", zh: "输入栏改成微信式：语音/键盘切换、⊕ 里拍照和相册，有内容才出现「发送」。", en: "WeChat-style composer: voice/keyboard toggle, camera and album under ⊕, and Send only when there's something to send." },
      { type: "improved", zh: "听不清时不再瞎猜：没听清的部分会标出来，确认后再发送。", en: "No more guessing when audio is unclear: unclear parts are marked and you confirm before sending." },
      { type: "fixed", zh: "麦克风权限只问一次；手机上点输入框不再放大页面。", en: "The microphone permission is asked only once; the page no longer zooms when you tap an input on phones." },
    ],
  },
  {
    id: "2026-10-20b",
    date: "2026-10-20",
    title: { zh: "装到手机桌面", en: "Install on your home screen" },
    items: [
      { type: "new", zh: "新增安装指南页（iPhone / 安卓 / 电脑 / 微信内打开），约 10 秒把 Fitness Buddy 放到手机桌面。", en: "New install guide (iPhone / Android / computer / in-app browsers): put Fitness Buddy on your home screen in about 10 seconds." },
      { type: "improved", zh: "「每日科学微课堂」每天更新，内容扩充到 24 条。", en: "The Daily Science tip now changes every day, with 24 tips in rotation." },
    ],
  },
  {
    id: "2026-10-20a",
    date: "2026-10-20",
    title: { zh: "教练记忆 & 每日对话", en: "Coach Memory & daily conversations" },
    items: [
      { type: "new", zh: "教练记忆：教练会记住你的偏好（忌口、训练时间等），在设置里可以查看、修改和删除。", en: "Coach Memory: your coach remembers preferences (foods you avoid, when you train…) - view, edit or delete them in Settings." },
      { type: "new", zh: "每天一段新对话（凌晨 4 点切换），往上滑可以连续查看以前的聊天。", en: "A fresh conversation every day (switches at 4 am); scroll up to read earlier days." },
      { type: "improved", zh: "手机和电脑上选的教练自动同步。", en: "Your chosen coach syncs between phone and computer." },
    ],
  },
  {
    id: "2026-10-19",
    date: "2026-10-19",
    title: { zh: "设置页 & 隐私控制", en: "Settings & privacy controls" },
    items: [
      { type: "new", zh: "全新设置页和插画风教练头像；教练回复支持朗读。", en: "New Settings page and illustrated coach avatars; coach replies can be read aloud." },
      { type: "new", zh: "隐私与数据共享开关；你和教练的对话管理员看不到。", en: "Privacy & data-sharing controls; administrators can't see your coach chats." },
      { type: "improved", zh: "手机上打开更快，加载时有骨架屏。", en: "Faster start on phones, with loading placeholders." },
    ],
  },
  {
    id: "2026-10-17",
    date: "2026-10-17",
    title: { zh: "动作指导 & 三位教练", en: "Form guides & three coaches" },
    items: [
      { type: "new", zh: "动作要点和演示，以及用摄像头的实时动作语音指导。", en: "Exercise form guides, plus live camera coaching with voice cues." },
      { type: "new", zh: "三位不同风格的教练可选。", en: "Choose between three coaches with different styles." },
      { type: "improved", zh: "点开餐食可以看照片和每样食物的营养明细。", en: "Tap a meal to see its photo and per-item nutrition." },
    ],
  },
  {
    id: "2026-10-16",
    date: "2026-10-16",
    title: { zh: "全新界面", en: "A brand-new app" },
    items: [
      { type: "new", zh: "今天 / 教练 / 进展 / 计划四个页面，中英文和深浅色主题。", en: "Today, Coach, Progress and Plan pages, in English and Chinese, light and dark." },
      { type: "new", zh: "数据导出和删除账号。", en: "Export your data or delete your account." },
      { type: "improved", zh: "改每日热量目标前会先让你确认。", en: "Changes to your daily calorie target ask for confirmation first." },
    ],
  },
  {
    id: "2026-10-15",
    date: "2026-10-15",
    title: { zh: "Fitness Buddy 上线", en: "Fitness Buddy launches" },
    items: [
      { type: "new", zh: "AI 健身教练：拍照记餐、量身定制训练计划、每周复盘和每日跟进。", en: "Your AI fitness coach: meal logging from photos, a training plan built for you, weekly reviews and daily check-ins." },
    ],
  },
];

export const LATEST_CHANGE_ID = CHANGELOG[0].id;
const SEEN_KEY = "fb.changelog_seen";

/** True when the latest entry is newer than what this browser has seen. */
export function hasUnseenChanges() {
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    return Boolean(seen) && seen < LATEST_CHANGE_ID;
  } catch (_) {
    return false;
  }
}

/**
 * First run of this feature: brand-new users start "seen" (nothing to badge);
 * people who already used the app see the entries since the log launched.
 */
export function initChangelogSeen({ returning = false } = {}) {
  try {
    if (!localStorage.getItem(SEEN_KEY)) localStorage.setItem(SEEN_KEY, returning ? "2026-10-20z" : LATEST_CHANGE_ID);
  } catch (_) { /* private mode */ }
}

export function markChangelogSeen() {
  try { localStorage.setItem(SEEN_KEY, LATEST_CHANGE_ID); } catch (_) { /* private mode */ }
}
