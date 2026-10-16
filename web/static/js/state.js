// Shared app state and a late-bound action registry (filled in by app.js) so
// view modules can trigger navigation / chat without circular imports.

export const state = {
  config: null,
  me: null,
  dashboard: null,
  range: 30,
  streaming: false,
  photo: null, // { blob, url }
  sessionReady: null, // Promise resolved when /api/session (and history) is done
  pendingGreeting: false, // new session that hasn't been greeted yet
  onboarding: false,
};

export const actions = {
  /** openCoach({ send, prefill, photo: "camera"|"gallery", focus }) */
  openCoach: () => {},
  navigate: () => {},
  refreshDashboard: () => {},
  signOut: () => {},
  showSignIn: () => {},
  markUnread: () => {},
  setLanguage: () => {},
  /** Called with true/false when a chat turn starts/ends. */
  setBusy: () => {},
  /** Called when a confirmation card arrives (card payload, DOM node). */
  onConfirmation: () => {},
};
