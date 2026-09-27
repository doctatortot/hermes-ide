import { describe, it, expect } from "vitest";
import {
	DEFAULT_EDITOR_FONT_PX,
	MIN_EDITOR_FONT_PX,
	MAX_EDITOR_FONT_PX,
	nextEditorFontSize,
	parseEditorFontSize,
} from "../editor/editorFontSize";

describe("parseEditorFontSize", () => {
	it("returns null (follow the UI) for missing input", () => {
		expect(parseEditorFontSize(undefined)).toBeNull();
		expect(parseEditorFontSize(null)).toBeNull();
		expect(parseEditorFontSize("")).toBeNull();
	});

	it("returns null (follow the UI) for unparseable input", () => {
		expect(parseEditorFontSize("not a number")).toBeNull();
		expect(parseEditorFontSize("NaN")).toBeNull();
	});

	it("accepts in-range integers", () => {
		expect(parseEditorFontSize("14")).toBe(14);
		expect(parseEditorFontSize("18")).toBe(18);
	});

	it("clamps below the minimum", () => {
		expect(parseEditorFontSize("1")).toBe(MIN_EDITOR_FONT_PX);
		expect(parseEditorFontSize("-100")).toBe(MIN_EDITOR_FONT_PX);
	});

	it("clamps above the maximum", () => {
		expect(parseEditorFontSize("999")).toBe(MAX_EDITOR_FONT_PX);
	});

	it("parses integer prefixes (parseInt semantics)", () => {
		expect(parseEditorFontSize("14px")).toBe(14);
	});
});

describe("nextEditorFontSize", () => {
	it("increments an existing override by 1", () => {
		expect(nextEditorFontSize(13, "increase", 12)).toBe(14);
	});

	it("decrements an existing override by 1", () => {
		expect(nextEditorFontSize(13, "decrease", 12)).toBe(12);
	});

	it("starts from the rendered size when there is no override", () => {
		// Default UI scale: --text-sm = 12px
		expect(nextEditorFontSize(null, "increase", 12)).toBe(13);
		expect(nextEditorFontSize(null, "decrease", 12)).toBe(11);
		// Compact (0.9) / comfortable (1.15) scales render fractional px
		expect(nextEditorFontSize(null, "increase", 10.8)).toBe(12);
		expect(nextEditorFontSize(null, "decrease", 13.8)).toBe(13);
	});

	it("falls back to the default when the rendered size is unusable", () => {
		expect(nextEditorFontSize(null, "increase", Number.NaN)).toBe(DEFAULT_EDITOR_FONT_PX + 1);
		expect(nextEditorFontSize(null, "increase", 0)).toBe(DEFAULT_EDITOR_FONT_PX + 1);
	});

	it("clears the override on reset", () => {
		expect(nextEditorFontSize(20, "reset", 12)).toBeNull();
		expect(nextEditorFontSize(8, "reset", 12)).toBeNull();
		expect(nextEditorFontSize(null, "reset", 12)).toBeNull();
	});

	it("clamps at the upper bound on increase", () => {
		expect(nextEditorFontSize(MAX_EDITOR_FONT_PX, "increase", 12)).toBe(MAX_EDITOR_FONT_PX);
		expect(nextEditorFontSize(null, "increase", 100)).toBe(MAX_EDITOR_FONT_PX);
	});

	it("clamps at the lower bound on decrease", () => {
		expect(nextEditorFontSize(MIN_EDITOR_FONT_PX, "decrease", 12)).toBe(MIN_EDITOR_FONT_PX);
		expect(nextEditorFontSize(null, "decrease", 4)).toBe(MIN_EDITOR_FONT_PX);
	});
});
