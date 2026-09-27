// ─── Editor font size ────────────────────────────────────────────────
//
// The editor pane has its own font-size dimension, separate from the
// terminal `font_size` setting. Bound to the persisted `editor_font_size`
// setting; mutated by Mod+= / Mod+- / Mod+0 shortcuts inside the editor.
//
// When no size is persisted (`null` here), the editor follows the UI:
// it keeps using `var(--text-sm)`, which `applyUiScale` rescales with the
// UI density and theme. The first zoom starts from the size the editor is
// currently rendered at, and reset clears the override again.

/** Fallback when the currently rendered size can't be read. */
export const DEFAULT_EDITOR_FONT_PX = 13;
export const MIN_EDITOR_FONT_PX = 8;
export const MAX_EDITOR_FONT_PX = 32;
export const EDITOR_FONT_STEP_PX = 1;

const clamp = (n: number): number =>
	Math.min(MAX_EDITOR_FONT_PX, Math.max(MIN_EDITOR_FONT_PX, n));

/** Parse a persisted setting value into an integer pixel size. Returns
 *  `null` on missing/invalid input, meaning "no override — follow the UI".
 *  The persisted value is clamped to the allowed range so that a
 *  hand-edited DB row can't push the editor to 2pt or 200pt. */
export function parseEditorFontSize(raw: string | undefined | null): number | null {
	if (raw == null || raw === "") return null;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return null;
	return clamp(n);
}

/** Apply an increase / decrease / reset action to the current override.
 *  `current` is `null` when the editor is following the UI; the step then
 *  starts from `renderedPx` (the editor's computed font size). Reset
 *  returns `null` to clear the override. */
export function nextEditorFontSize(
	current: number | null,
	action: "increase" | "decrease" | "reset",
	renderedPx: number,
): number | null {
	if (action === "reset") return null;
	const base =
		current ?? (Number.isFinite(renderedPx) && renderedPx > 0 ? Math.round(renderedPx) : DEFAULT_EDITOR_FONT_PX);
	const step = action === "increase" ? EDITOR_FONT_STEP_PX : -EDITOR_FONT_STEP_PX;
	return clamp(base + step);
}
