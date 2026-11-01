/*
Lets a subpage title cut short by an ellipsis (a long friend name) be read in
full: hovering it with a mouse, or tapping it on touch, expands it over the
header buttons; tapping again or anywhere else collapses it.

Delegated on the document once, since subpages re-render their title freely.
@category ui
*/

const isTruncated = (title) => title.scrollWidth > title.clientWidth + 1;

const expand = (title) => {
  if (!isTruncated(title)) return;
  // Allow the expanded title the whole header width right of the back button.
  const header = title.closest(".subpage-header");
  const wrap = title.parentElement;
  if (header && wrap) {
    const room = header.getBoundingClientRect().right - wrap.getBoundingClientRect().left;
    title.style.setProperty("--title-max-width", `${room}px`);
  }
  title.classList.add("is-truncated", "is-expanded");
};

const collapse = (title) => title.classList.remove("is-expanded");

export const setupSubpageTitleExpand = () => {
  const canHover = window.matchMedia("(hover: hover)").matches;
  document.addEventListener("pointerover", (event) => {
    const title = event.target.closest?.(".subpage-title");
    if (!title) return;
    if (isTruncated(title)) title.classList.add("is-truncated");
    if (canHover && event.pointerType === "mouse") expand(title);
  });
  document.addEventListener("pointerout", (event) => {
    const title = event.target.closest?.(".subpage-title");
    if (!title || event.pointerType !== "mouse" || title.contains(event.relatedTarget)) return;
    collapse(title);
  });
  document.addEventListener("click", (event) => {
    const title = event.target.closest?.(".subpage-title");
    document.querySelectorAll(".subpage-title.is-expanded").forEach((open) => {
      if (open !== title) collapse(open);
    });
    if (!title || canHover) return;
    if (title.classList.contains("is-expanded")) collapse(title);
    else expand(title);
  });
};
