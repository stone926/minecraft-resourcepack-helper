import { clamp } from "./webviewApi.js";

const DETAILS_MIN_SIZE = 72;
const DETAILS_KEYBOARD_STEP = 24;
const DETAILS_STACKED_QUERY = "(max-width: 780px)";

export class DetailsPanelController {
  constructor(layout, panel, resizer) {
    this.layout = layout;
    this.panel = panel;
    this.resizer = resizer;
    this.stackedQuery = window.matchMedia(DETAILS_STACKED_QUERY);
    this.dragging = false;
    this.disposables = [];

    this.installToggles();
    this.installResizer();
    this.updateOrientation();
    this.updateCollapsedLayout();
    this.addDomListener(this.stackedQuery, "change", () => this.updateOrientation());
  }

  addDomListener(target, type, listener) {
    target.addEventListener(type, listener);
    this.disposables.push(() => target.removeEventListener(type, listener));
  }

  installToggles() {
    for (const button of document.querySelectorAll("[data-details-toggle]")) {
      this.addDomListener(button, "click", () => this.toggleSection(button));
    }
  }

  toggleSection(button) {
    const section = button.closest("[data-details-section]");
    if (!section) {
      return;
    }

    const expanded = button.getAttribute("aria-expanded") !== "false";
    section.classList.toggle("is-collapsed", expanded);
    button.setAttribute("aria-expanded", String(!expanded));
    this.updateCollapsedLayout();
  }

  installResizer() {
    this.addDomListener(this.resizer, "pointerdown", event => this.startResize(event));
    this.addDomListener(this.resizer, "keydown", event => this.resizeWithKeyboard(event));
  }

  startResize(event) {
    event.preventDefault();
    this.dragging = true;
    this.resizer.classList.add("is-dragging");
    this.resizer.setPointerCapture(event.pointerId);

    const move = moveEvent => this.resizeFromPointer(moveEvent);
    const stop = () => {
      this.dragging = false;
      this.resizer.classList.remove("is-dragging");
      this.resizer.removeEventListener("pointermove", move);
      this.resizer.removeEventListener("pointerup", stop);
      this.resizer.removeEventListener("pointercancel", stop);
    };

    this.resizer.addEventListener("pointermove", move);
    this.resizer.addEventListener("pointerup", stop);
    this.resizer.addEventListener("pointercancel", stop);
    this.disposables.push(() => {
      this.resizer.removeEventListener("pointermove", move);
      this.resizer.removeEventListener("pointerup", stop);
      this.resizer.removeEventListener("pointercancel", stop);
    });
  }

  resizeFromPointer(event) {
    const rect = this.layout.getBoundingClientRect();
    if (this.isStacked()) {
      this.setDetailsHeight(rect.bottom - event.clientY);
      return;
    }

    this.setDetailsWidth(rect.right - event.clientX);
  }

  resizeWithKeyboard(event) {
    const keyDelta = keyboardResizeDelta(event.key);
    if (keyDelta === 0) {
      return;
    }

    event.preventDefault();
    if (this.isStacked()) {
      this.setDetailsHeight(this.panel.getBoundingClientRect().height + keyDelta);
      return;
    }

    this.setDetailsWidth(this.panel.getBoundingClientRect().width + keyDelta);
  }

  setDetailsHeight(height) {
    const layoutHeight = this.layout.getBoundingClientRect().height;
    const maxHeight = Math.max(DETAILS_MIN_SIZE, Math.floor(layoutHeight * 0.68));
    this.layout.style.setProperty("--details-height", `${clamp(height, DETAILS_MIN_SIZE, maxHeight)}px`);
    this.layout.classList.add("details-has-manual-height");
  }

  setDetailsWidth(width) {
    const layoutWidth = this.layout.getBoundingClientRect().width;
    const maxWidth = Math.max(220, Math.floor(layoutWidth * 0.58));
    this.layout.style.setProperty("--details-width", `${clamp(width, 220, maxWidth)}px`);
  }

  updateOrientation() {
    this.resizer.setAttribute("aria-orientation", this.isStacked() ? "horizontal" : "vertical");
    this.updateCollapsedLayout();
  }

  isStacked() {
    return this.stackedQuery.matches;
  }

  updateCollapsedLayout() {
    const sections = [...this.panel.querySelectorAll("[data-details-section]")];
    const allCollapsed = sections.length > 0 && sections.every(section => section.classList.contains("is-collapsed"));
    this.layout.classList.toggle("details-all-collapsed", allCollapsed);
  }

  dispose() {
    for (const dispose of this.disposables.splice(0)) {
      dispose();
    }
  }
}

function keyboardResizeDelta(key) {
  switch (key) {
    case "ArrowUp":
    case "ArrowLeft":
      return DETAILS_KEYBOARD_STEP;
    case "ArrowDown":
    case "ArrowRight":
      return -DETAILS_KEYBOARD_STEP;
    default:
      return 0;
  }
}
