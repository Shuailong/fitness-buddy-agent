// What's new: user-facing release notes, newest first. Shown on /changelog and
// used by the app to badge "new" until the user has seen the latest entry.
// Add an entry at the top for every user-visible change (keep ids unique and
// increasing: YYYY-MM-DD plus a letter when there are several in a day).
export const CHANGELOG = [
  {
    id: "2026-10-21c",
    date: "2026-10-21",
    title: { zh: "更清爽的导航", en: "A cleaner layout" },
    items: [
      { type: "improved", zh: "底部只保留「今天 / 进展 / 计划」三个页面；教练变成右下角的悬浮头像，任何页面点一下就能聊。", en: "The bottom bar now has just Today, Progress and Plan; your coach is a floating button you can open from any page." },
      { type: "improved", zh: "点右上角头像进入设置；设置页精简为常用项，其余收进「更多」。", en: "Tap your avatar for Settings - everyday options up top, the rest under “More”." },
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
