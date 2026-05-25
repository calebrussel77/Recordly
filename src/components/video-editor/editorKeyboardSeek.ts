const DEFAULT_EDITOR_ARROW_SEEK_FRAME_RATE = 30;
const EDITOR_ARROW_SEEK_SHIFT_SECONDS = 1;

type ResolveEditorArrowKeySeekTimeOptions = {
	key: string;
	currentTimeSeconds: number;
	durationSeconds: number;
	frameRate?: number | string | null;
	shiftKey?: boolean;
};

function clampTime(value: number, durationSeconds: number) {
	const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
	return Math.min(duration, Math.max(0, value));
}

function resolveFrameRate(frameRate: number | string | null | undefined) {
	const numericFrameRate = Number(frameRate);
	return Number.isFinite(numericFrameRate) && numericFrameRate > 0
		? numericFrameRate
		: DEFAULT_EDITOR_ARROW_SEEK_FRAME_RATE;
}

export function resolveEditorArrowKeySeekTime({
	key,
	currentTimeSeconds,
	durationSeconds,
	frameRate,
	shiftKey = false,
}: ResolveEditorArrowKeySeekTimeOptions) {
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return null;
	}

	const direction = key === "ArrowLeft" ? -1 : 1;
	const stepSeconds = shiftKey
		? EDITOR_ARROW_SEEK_SHIFT_SECONDS
		: 1 / resolveFrameRate(frameRate);

	return clampTime(currentTimeSeconds + direction * stepSeconds, durationSeconds);
}
