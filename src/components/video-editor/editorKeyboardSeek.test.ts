import { describe, expect, it } from "vitest";
import { resolveEditorArrowKeySeekTime } from "./editorKeyboardSeek";

describe("resolveEditorArrowKeySeekTime", () => {
	it("moves one frame with the left and right arrow keys", () => {
		expect(
			resolveEditorArrowKeySeekTime({
				key: "ArrowRight",
				currentTimeSeconds: 5,
				durationSeconds: 10,
				frameRate: 25,
			}),
		).toBeCloseTo(5.04);

		expect(
			resolveEditorArrowKeySeekTime({
				key: "ArrowLeft",
				currentTimeSeconds: 5,
				durationSeconds: 10,
				frameRate: 25,
			}),
		).toBeCloseTo(4.96);
	});

	it("uses one second steps with shift and clamps to the timeline", () => {
		expect(
			resolveEditorArrowKeySeekTime({
				key: "ArrowLeft",
				currentTimeSeconds: 0.25,
				durationSeconds: 10,
				frameRate: 60,
				shiftKey: true,
			}),
		).toBe(0);

		expect(
			resolveEditorArrowKeySeekTime({
				key: "ArrowRight",
				currentTimeSeconds: 9.5,
				durationSeconds: 10,
				frameRate: 60,
				shiftKey: true,
			}),
		).toBe(10);
	});

	it("ignores non-arrow keys", () => {
		expect(
			resolveEditorArrowKeySeekTime({
				key: ">",
				currentTimeSeconds: 5,
				durationSeconds: 10,
				frameRate: 30,
			}),
		).toBeNull();
	});
});
