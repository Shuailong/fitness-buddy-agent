// Pre-sign-in marketing page: smooth anchor scrolling under the sticky nav,
// reveal-on-scroll, localized product screenshots and the nav "Sign in" button.
import { $ } from "./util.js";
import { t, getLang } from "./i18n.js";

const IMG_BASE = "/static/img/landing";
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let initialized = false;

/** Points every product screenshot at the current language (1x/2x WebP) with localized alt text. */
export function updateLandingImages() {
  const lang = getLang() === "zh" ? "zh" : "en";
  for (const img of document.querySelectorAll("#landing-view img.lp-shot")) {
    const name = img.dataset.shot;
    const src1 = `${IMG_BASE}/${name}-${lang}@1x.webp`;
    if (img.dataset.lang === lang) continue;
    img.dataset.lang = lang;
    img.srcset = `${src1} 1x, ${IMG_BASE}/${name}-${lang}@2x.webp 2x`;
    img.src = src1;
    img.alt = t(`lp.img.${name}`);
  }
}

/** Re-applies localized alt text (src only changes when the language does). */
export function localizeLandingImages() {
  for (const img of document.querySelectorAll("#landing-view img.lp-shot")) delete img.dataset.lang;
  updateLandingImages();
}

function scrollToSection(id) {
  const behavior = reduceMotion() ? "auto" : "smooth";
  if (id === "lp-top") {
    window.scrollTo({ top: 0, behavior });
    return;
  }
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior, block: "start" });
  const heading = target.querySelector("h2");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
}

function highlightSignIn() {
  scrollToSection("lp-top");
  const slot = $("gis-hero");
  slot.classList.remove("pulse");
  // Restart the animation.
  void slot.offsetWidth;
  slot.classList.add("pulse");
  slot.focus({ preventScroll: true });
}

export function initLanding() {
  updateLandingImages();
  if (initialized) return;
  initialized = true;
  const root = $("landing-view");
  for (const link of root.querySelectorAll("[data-scroll]")) {
    link.addEventListener("click", (e) => {
      // Keep the URL hash free for app routing (#today, #coach, ...).
      e.preventDefault();
      scrollToSection(link.dataset.scroll);
    });
  }
  $("lp-signin-btn").addEventListener("click", highlightSignIn);
  const nav = $("lp-nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (!reduceMotion() && "IntersectionObserver" in window) {
    document.documentElement.classList.add("lp-anim");
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (const node of root.querySelectorAll(".reveal")) io.observe(node);
  }
}
