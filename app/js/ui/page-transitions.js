/*
This module encapsulates page slide transitions for the app shell. It determines direction from route context and applies coordinated enter/exit transforms for stacked page views.

It also guards against race conditions during rapid navigation by sequencing swaps and normalizing the container before each transition.
@category ui
*/

import { Route } from "./routes.js";

const PAGE_CLASS = "page-view";
const ACTIVE_CLASS = "is-active";
const ENTERING_CLASS = "is-entering";
const EXITING_CLASS = "is-exiting";

const transitionSequences = new WeakMap();

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

// Re-apply a carried scroll offset until it sticks. The first assignment can
// clamp short because binders finish asynchronously (a push-permission hint, a
// lazily rendered list) and grow the page only after it is mounted. Retries are
// bounded, and stop as soon as the target is reached or the reader scrolls past
// it themselves.
const restoreScrollTop = (page, top) => {
  if (!top) return;
  page.scrollTop = top;
  let framesLeft = 12;
  const reapply = () => {
    if (framesLeft-- <= 0 || page.scrollTop >= top || !page.isConnected) return;
    page.scrollTop = top;
    requestAnimationFrame(reapply);
  };
  requestAnimationFrame(reapply);
};

const nextPaint = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

const waitForTransitionEnd = (element, { timeoutMs = 400 } = {}) =>
  new Promise((resolve) => {
    if (!element) {
      resolve();
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      element.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      resolve();
    };

    const onEnd = (event) => {
      if (event.target !== element) return;
      if (event.propertyName !== "transform") return;
      settle();
    };

    const timer = window.setTimeout(settle, timeoutMs);
    element.addEventListener("transitionend", onEnd);
  });

const getPages = (container) =>
  Array.from(container?.querySelectorAll?.(`:scope > .${PAGE_CLASS}`) ?? []);

const getActivePage = (container) =>
  container?.querySelector?.(`:scope > .${PAGE_CLASS}.${ACTIVE_CLASS}`) ??
  container?.querySelector?.(`:scope > .${PAGE_CLASS}:last-child`) ??
  null;

const normalizeContainer = (container) => {
  if (!container) return;

  const pages = getPages(container);
  if (pages.length <= 1) {
    const onlyPage = pages[0];
    if (onlyPage) {
      onlyPage.classList.add(PAGE_CLASS, ACTIVE_CLASS);
      onlyPage.classList.remove(ENTERING_CLASS, EXITING_CLASS);
      onlyPage.style.transform = "";
      onlyPage.removeAttribute("aria-hidden");
    }
    container.removeAttribute("data-transitioning");
    return;
  }

  const keep = pages[pages.length - 1];
  pages.slice(0, -1).forEach((page) => page.remove());
  keep.classList.add(PAGE_CLASS, ACTIVE_CLASS);
  keep.classList.remove(ENTERING_CLASS, EXITING_CLASS);
  keep.style.transform = "";
  keep.removeAttribute("aria-hidden");
  container.removeAttribute("data-transitioning");
};

export const getSlideDirection = (fromRoute, toRoute, navOrder) => {
  if (!fromRoute || !toRoute) return null;

  const getDepth = (route) => {
    if (!route) return 0;
    if (route.type === Route.PAGE) return 0;
    if (route.type === Route.FRIEND || route.type === Route.ADD_FRIEND) return 1;
    if (route.type === Route.RECORD || route.type === Route.REQUEST || route.type === Route.TRUST || route.type === Route.SEND_LINK) return 2;
    return 1;
  };

  if (fromRoute.type !== Route.PAGE && toRoute.type === Route.PAGE) {
    const fromPage = fromRoute.mainPage;
    const toPage = toRoute.page;
    if (fromPage && toPage) {
      if (fromPage === toPage) {
        return "from-left";
      }
      const fromIndex = navOrder.indexOf(fromPage);
      const toIndex = navOrder.indexOf(toPage);
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        return toIndex > fromIndex ? "from-right" : "from-left";
      }
    }
  }

  const fromDepth = getDepth(fromRoute);
  const toDepth = getDepth(toRoute);

  if (fromDepth !== toDepth) {
    return toDepth > fromDepth ? "from-right" : "from-left";
  }

  if (fromRoute.type === Route.PAGE && toRoute.type === Route.PAGE) {
    const fromIndex = navOrder.indexOf(fromRoute.page);
    const toIndex = navOrder.indexOf(toRoute.page);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
    return toIndex > fromIndex ? "from-right" : "from-left";
  }

  return null;
};

/**
 * @param {HTMLElement} container
 * @param {HTMLElement} nextPage
 * @param {{ direction?: string | null, resetScroll?: boolean }} [options]
 */
export const swapPage = async (container, nextPage, { direction, resetScroll = false } = {}) => {
  if (!container || !nextPage) return;

  const seq = (transitionSequences.get(container) ?? 0) + 1;
  transitionSequences.set(container, seq);

  normalizeContainer(container);

  nextPage.classList.add(PAGE_CLASS);

  const currentPage = getActivePage(container);

  // Every page view is its own scroll container, so scroll needs no correction
  // during a swap: a freshly built page starts at its top, and the outgoing one
  // keeps the offset the user left it at while it slides away. The exception is
  // re-rendering the *same* page (a data change), which builds a new element and
  // would otherwise silently jump the reader back to the top — carry it over.
  const carriedScrollTop = !resetScroll && currentPage ? currentPage.scrollTop : 0;
  const mount = (page) => {
    container.appendChild(page);
    restoreScrollTop(page, carriedScrollTop);
  };

  if (!currentPage) {
    nextPage.classList.add(ACTIVE_CLASS);
    mount(nextPage);
    return;
  }

  if (!direction || prefersReducedMotion()) {
    currentPage.remove();
    nextPage.classList.add(ACTIVE_CLASS);
    mount(nextPage);
    container.removeAttribute("data-transitioning");
    return;
  }

  const enterFromRight = direction === "from-right";
  const enterStart = enterFromRight ? "100%" : "-100%";
  const exitEnd = enterFromRight ? "-100%" : "100%";

  if (document.activeElement instanceof HTMLElement && currentPage.contains(document.activeElement)) {
    document.activeElement.blur();
  }

  currentPage.classList.remove(ACTIVE_CLASS);
  currentPage.classList.add(EXITING_CLASS);
  currentPage.setAttribute("aria-hidden", "true");

  nextPage.classList.add(ENTERING_CLASS);
  nextPage.style.transform = `translateX(${enterStart})`;

  container.setAttribute("data-transitioning", "true");
  mount(nextPage);

  // Ensure the entering page has a committed "offscreen" paint before starting the transition.
  // This avoids cases on slower devices where only the exiting page animates.
  nextPage.getBoundingClientRect();
  currentPage.getBoundingClientRect();

  await nextPaint();
  if (transitionSequences.get(container) !== seq) return;
  currentPage.style.transform = `translateX(${exitEnd})`;
  nextPage.style.transform = "translateX(0%)";

  await Promise.all([
    waitForTransitionEnd(currentPage, { timeoutMs: 650 }),
    waitForTransitionEnd(nextPage, { timeoutMs: 650 }),
  ]);
  if (transitionSequences.get(container) !== seq) return;

  currentPage.remove();
  nextPage.classList.remove(ENTERING_CLASS);
  nextPage.classList.add(ACTIVE_CLASS);
  nextPage.style.transform = "";
  nextPage.removeAttribute("aria-hidden");

  container.removeAttribute("data-transitioning");
};
