import type { ImageSegmenter, MPMask } from "@mediapipe/tasks-vision";
import { getAssetPath } from "@/lib/assetPath";
import {
	type CropRegion,
	DEFAULT_WEBCAM_SMART_BACKGROUND_QUALITY,
	type WebcamSmartBackgroundPresetId,
	type WebcamSmartBackgroundQuality,
} from "./types";
import { getWebcamCropSourceRect } from "./webcamOverlay";
import {
	getWebcamSmartBackgroundPreset,
	type WebcamSmartBackgroundPreset,
} from "./webcamSmartBackgroundPresets";

const MEDIAPIPE_WASM_DIR = "mediapipe/tasks-vision/wasm";
const SELFIE_SEGMENTER_MODELS: Record<WebcamSmartBackgroundQuality, string> = {
	fast: "mediapipe/models/selfie_segmenter_landscape.tflite",
	balanced: "mediapipe/models/selfie_segmenter.tflite",
};
const PERSON_CONFIDENCE_MASK_INDEX = 1;
const MASK_ENTER_THRESHOLD = 0.18;
const MASK_FULL_THRESHOLD = 0.68;
const TEMPORAL_SMOOTHING = 0.58;
const TEMPORAL_RESET_GAP_MS = 320;
const EDGE_BLUR_MIN_ALPHA = 0.03;
const EDGE_BLUR_MAX_ALPHA = 0.98;

type SmartBackgroundWorkspace = {
	frameCanvas: HTMLCanvasElement;
	frameCtx: CanvasRenderingContext2D;
	maskCanvas: HTMLCanvasElement;
	maskCtx: CanvasRenderingContext2D;
	foregroundCanvas: HTMLCanvasElement;
	foregroundCtx: CanvasRenderingContext2D;
};

export type SmartWebcamBackgroundRenderer = {
	prepare: (
		quality?: WebcamSmartBackgroundQuality,
		backgroundPresetId?: WebcamSmartBackgroundPresetId,
	) => Promise<boolean>;
	isReady: (quality?: WebcamSmartBackgroundQuality) => boolean;
	render: (options: SmartWebcamBackgroundRenderOptions) => boolean;
	close: () => void;
};

export type SmartWebcamBackgroundRenderOptions = {
	source: CanvasImageSource | VideoFrame;
	sourceWidth: number;
	sourceHeight: number;
	outputCanvas: HTMLCanvasElement;
	cropRegion?: Partial<CropRegion> | null;
	mirror?: boolean;
	backgroundColor: string;
	backgroundPresetId?: WebcamSmartBackgroundPresetId;
	quality?: WebcamSmartBackgroundQuality;
	timestampMs?: number;
};

type SmartBackgroundImageState = {
	image: HTMLImageElement;
	promise: Promise<boolean>;
	ready: boolean;
	failed: boolean;
};

type TasksVisionModule = typeof import("@mediapipe/tasks-vision");

let tasksVisionModulePromise: Promise<TasksVisionModule> | null = null;

function loadTasksVisionModule(): Promise<TasksVisionModule> {
	tasksVisionModulePromise ??= import("@mediapipe/tasks-vision");
	return tasksVisionModulePromise;
}

function createCanvasContext(
	width: number,
	height: number,
	willReadFrequently = false,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", {
		alpha: true,
		willReadFrequently,
	});
	if (!context) {
		throw new Error("Canvas 2D context unavailable");
	}
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	return [canvas, context];
}

function ensureCanvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
	const nextWidth = Math.max(1, Math.round(width));
	const nextHeight = Math.max(1, Math.round(height));
	if (canvas.width !== nextWidth) {
		canvas.width = nextWidth;
	}
	if (canvas.height !== nextHeight) {
		canvas.height = nextHeight;
	}
}

function createWorkspace(): SmartBackgroundWorkspace {
	const [frameCanvas, frameCtx] = createCanvasContext(1, 1);
	const [maskCanvas, maskCtx] = createCanvasContext(1, 1, true);
	const [foregroundCanvas, foregroundCtx] = createCanvasContext(1, 1);

	return {
		frameCanvas,
		frameCtx,
		maskCanvas,
		maskCtx,
		foregroundCanvas,
		foregroundCtx,
	};
}

function smoothstep(edge0: number, edge1: number, value: number) {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

function normalizeSmartBackgroundQuality(
	quality?: WebcamSmartBackgroundQuality,
): WebcamSmartBackgroundQuality {
	return quality === "fast" || quality === "balanced"
		? quality
		: DEFAULT_WEBCAM_SMART_BACKGROUND_QUALITY;
}

function drawLinearGradientBackground(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	preset: WebcamSmartBackgroundPreset,
) {
	if (!preset.gradient?.length) {
		context.fillStyle = preset.fallbackColor;
		context.fillRect(0, 0, width, height);
		return;
	}
	const gradient = context.createLinearGradient(0, 0, width, height);
	for (const stop of preset.gradient ?? []) {
		gradient.addColorStop(stop.offset, stop.color);
	}
	context.fillStyle = gradient;
	context.fillRect(0, 0, width, height);

	const glow = context.createRadialGradient(
		width * 0.35,
		height * 0.2,
		0,
		width * 0.35,
		height * 0.2,
		Math.max(width, height) * 0.82,
	);
	glow.addColorStop(0, "rgba(255, 255, 255, 0.22)");
	glow.addColorStop(0.52, "rgba(255, 255, 255, 0.05)");
	glow.addColorStop(1, "rgba(0, 0, 0, 0.18)");
	context.fillStyle = glow;
	context.fillRect(0, 0, width, height);
}

function drawBokehBackground(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	preset: WebcamSmartBackgroundPreset,
) {
	drawLinearGradientBackground(context, width, height, preset);
	const circles = [
		{ x: 0.24, y: 0.2, radius: 0.12, alpha: 0.42 },
		{ x: 0.72, y: 0.28, radius: 0.16, alpha: 0.34 },
		{ x: 0.58, y: 0.64, radius: 0.2, alpha: 0.18 },
		{ x: 0.18, y: 0.68, radius: 0.1, alpha: 0.26 },
		{ x: 0.86, y: 0.72, radius: 0.12, alpha: 0.2 },
	];

	for (const circle of circles) {
		const radius = Math.max(width, height) * circle.radius;
		const gradient = context.createRadialGradient(
			width * circle.x,
			height * circle.y,
			0,
			width * circle.x,
			height * circle.y,
			radius,
		);
		gradient.addColorStop(0, `rgba(255, 255, 255, ${circle.alpha})`);
		gradient.addColorStop(0.52, `rgba(255, 255, 255, ${circle.alpha * 0.22})`);
		gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
		context.fillStyle = gradient;
		context.beginPath();
		context.arc(width * circle.x, height * circle.y, radius, 0, Math.PI * 2);
		context.fill();
	}
}

function drawCoveredImage(
	context: CanvasRenderingContext2D,
	image: CanvasImageSource,
	width: number,
	height: number,
) {
	const sourceWidth =
		"naturalWidth" in image && typeof image.naturalWidth === "number"
			? image.naturalWidth
			: "width" in image && typeof image.width === "number"
				? image.width
				: width;
	const sourceHeight =
		"naturalHeight" in image && typeof image.naturalHeight === "number"
			? image.naturalHeight
			: "height" in image && typeof image.height === "number"
				? image.height
				: height;
	const coverScale = Math.max(width / sourceWidth, height / sourceHeight);
	const drawWidth = sourceWidth * coverScale;
	const drawHeight = sourceHeight * coverScale;
	const drawX = (width - drawWidth) / 2;
	const drawY = (height - drawHeight) / 2;
	context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function refineEdgeAlpha(alpha: Float32Array, width: number, height: number) {
	const refined = new Float32Array(alpha.length);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			const current = alpha[index] ?? 0;
			if (current <= EDGE_BLUR_MIN_ALPHA || current >= EDGE_BLUR_MAX_ALPHA) {
				refined[index] = current;
				continue;
			}

			let weightedAlpha = current * 4;
			let weight = 4;
			for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
				const neighborY = y + yOffset;
				if (neighborY < 0 || neighborY >= height) {
					continue;
				}
				for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
					if (xOffset === 0 && yOffset === 0) {
						continue;
					}
					const neighborX = x + xOffset;
					if (neighborX < 0 || neighborX >= width) {
						continue;
					}
					weightedAlpha += alpha[neighborY * width + neighborX] ?? 0;
					weight += 1;
				}
			}
			refined[index] = weightedAlpha / weight;
		}
	}

	return refined;
}

function drawCoveredSource(
	context: CanvasRenderingContext2D,
	source: CanvasImageSource | VideoFrame,
	sourceWidth: number,
	sourceHeight: number,
	cropRegion: Partial<CropRegion> | null | undefined,
	mirror: boolean,
	outputWidth: number,
	outputHeight: number,
) {
	const { sx, sy, sw, sh } = getWebcamCropSourceRect(cropRegion, sourceWidth, sourceHeight);
	const coverScale = Math.max(outputWidth / sw, outputHeight / sh);
	const drawWidth = sw * coverScale;
	const drawHeight = sh * coverScale;
	const drawX = (outputWidth - drawWidth) / 2;
	const drawY = (outputHeight - drawHeight) / 2;

	context.save();
	if (mirror) {
		context.translate(outputWidth, 0);
		context.scale(-1, 1);
	}
	context.drawImage(source, sx, sy, sw, sh, drawX, drawY, drawWidth, drawHeight);
	context.restore();
}

function getMaskConfidenceData(mask: MPMask) {
	if (mask.hasFloat32Array()) {
		return { data: mask.getAsFloat32Array(), scale: 1 };
	}
	if (mask.hasUint8Array()) {
		return { data: mask.getAsUint8Array(), scale: 1 / 255 };
	}
	return null;
}

function drawMaskImageData(
	mask: MPMask,
	maskCtx: CanvasRenderingContext2D,
	previousAlpha: Float32Array | null,
	smoothingEnabled: boolean,
) {
	const confidence = getMaskConfidenceData(mask);
	if (!confidence) {
		return null;
	}

	const { width, height } = mask;
	const pixelCount = width * height;
	const imageData = maskCtx.createImageData(width, height);
	const output = imageData.data;
	const nextAlpha = new Float32Array(pixelCount);

	for (let index = 0; index < pixelCount; index += 1) {
		const rawConfidence = Number(confidence.data[index] ?? 0) * confidence.scale;
		let alpha = smoothstep(MASK_ENTER_THRESHOLD, MASK_FULL_THRESHOLD, rawConfidence);
		if (smoothingEnabled && previousAlpha && previousAlpha.length === pixelCount) {
			alpha = previousAlpha[index] * TEMPORAL_SMOOTHING + alpha * (1 - TEMPORAL_SMOOTHING);
		}
		nextAlpha[index] = alpha;
	}

	const refinedAlpha = refineEdgeAlpha(nextAlpha, width, height);
	for (let index = 0; index < pixelCount; index += 1) {
		const offset = index * 4;
		output[offset] = 255;
		output[offset + 1] = 255;
		output[offset + 2] = 255;
		output[offset + 3] = Math.round((refinedAlpha[index] ?? 0) * 255);
	}

	maskCtx.putImageData(imageData, 0, 0);
	return refinedAlpha;
}

function drawReplacementBackground(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	backgroundColor: string,
	backgroundPresetId: WebcamSmartBackgroundPresetId | undefined,
	backgroundImage?: HTMLImageElement,
) {
	const preset = getWebcamSmartBackgroundPreset(backgroundPresetId);

	if (preset.kind === "image" && backgroundImage) {
		context.save();
		context.filter = "blur(10px) saturate(1.08) brightness(0.9)";
		const bleed = Math.max(width, height) * 0.04;
		context.translate(-bleed, -bleed);
		drawCoveredImage(context, backgroundImage, width + bleed * 2, height + bleed * 2);
		context.restore();
		context.fillStyle = "rgba(0, 0, 0, 0.16)";
		context.fillRect(0, 0, width, height);
		return;
	}

	if (preset.kind === "gradient") {
		drawLinearGradientBackground(context, width, height, preset);
		return;
	}

	if (preset.kind === "bokeh") {
		drawBokehBackground(context, width, height, preset);
		return;
	}

	context.fillStyle = preset.color ?? backgroundColor;
	context.fillRect(0, 0, width, height);

	const highlight = context.createRadialGradient(
		width * 0.5,
		height * 0.28,
		0,
		width * 0.5,
		height * 0.28,
		Math.max(width, height) * 0.74,
	);
	highlight.addColorStop(0, "rgba(255, 255, 255, 0.24)");
	highlight.addColorStop(0.55, "rgba(255, 255, 255, 0.04)");
	highlight.addColorStop(1, "rgba(0, 0, 0, 0.20)");
	context.fillStyle = highlight;
	context.fillRect(0, 0, width, height);
}

export function createSmartWebcamBackgroundRenderer(): SmartWebcamBackgroundRenderer | null {
	if (typeof document === "undefined") {
		return null;
	}

	let workspace: SmartBackgroundWorkspace;
	try {
		workspace = createWorkspace();
	} catch {
		return null;
	}

	const segmentersByQuality = new Map<WebcamSmartBackgroundQuality, ImageSegmenter>();
	const preparePromisesByQuality = new Map<WebcamSmartBackgroundQuality, Promise<boolean>>();
	const backgroundImagesByPreset = new Map<
		WebcamSmartBackgroundPresetId,
		SmartBackgroundImageState
	>();
	let activeQuality: WebcamSmartBackgroundQuality = DEFAULT_WEBCAM_SMART_BACKGROUND_QUALITY;
	let previousAlpha: Float32Array | null = null;
	let previousMaskWidth = 0;
	let previousMaskHeight = 0;
	let lastTimestampMs = 0;
	let lastSegmentationTimestampMs = -Infinity;

	const resetTemporalState = () => {
		previousAlpha = null;
		previousMaskWidth = 0;
		previousMaskHeight = 0;
		lastSegmentationTimestampMs = -Infinity;
	};

	const getNextTimestamp = (timestampMs?: number) => {
		const candidate =
			typeof timestampMs === "number" && Number.isFinite(timestampMs)
				? timestampMs
				: typeof performance === "undefined"
					? Date.now()
					: performance.now();
		lastTimestampMs = Math.max(lastTimestampMs + 1, candidate);
		return lastTimestampMs;
	};

	const prepareBackgroundPreset = async (
		backgroundPresetId?: WebcamSmartBackgroundPresetId,
	): Promise<boolean> => {
		const preset = getWebcamSmartBackgroundPreset(backgroundPresetId);
		if (preset.kind !== "image" || !preset.assetPath || typeof Image === "undefined") {
			return true;
		}

		const existing = backgroundImagesByPreset.get(preset.id);
		if (existing) {
			return existing.ready || (!existing.failed && (await existing.promise));
		}

		const image = new Image();
		image.crossOrigin = "anonymous";
		const promise = (async () => {
			try {
				const imageUrl = await getAssetPath(preset.assetPath?.replace(/^\/+/, "") ?? "");
				await new Promise<void>((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject(new Error(`Failed to load ${imageUrl}`));
					image.src = imageUrl;
				});
				const state = backgroundImagesByPreset.get(preset.id);
				if (state) {
					state.ready = true;
				}
				return true;
			} catch (error) {
				console.warn("[webcam-smart-background] background image load failed", error);
				const state = backgroundImagesByPreset.get(preset.id);
				if (state) {
					state.failed = true;
				}
				return false;
			}
		})();
		backgroundImagesByPreset.set(preset.id, {
			image,
			promise,
			ready: false,
			failed: false,
		});
		return promise;
	};

	const renderer: SmartWebcamBackgroundRenderer = {
		async prepare(quality, backgroundPresetId) {
			const smartBackgroundQuality = normalizeSmartBackgroundQuality(quality);
			await prepareBackgroundPreset(backgroundPresetId);
			if (segmentersByQuality.has(smartBackgroundQuality)) {
				return true;
			}

			const pendingPrepare = preparePromisesByQuality.get(smartBackgroundQuality);
			if (pendingPrepare) {
				return pendingPrepare;
			}

			const preparePromise = (async () => {
				try {
					const [{ FilesetResolver, ImageSegmenter }, wasmPath, modelPath] =
						await Promise.all([
							loadTasksVisionModule(),
							getAssetPath(MEDIAPIPE_WASM_DIR),
							getAssetPath(SELFIE_SEGMENTER_MODELS[smartBackgroundQuality]),
						]);
					const vision = await FilesetResolver.forVisionTasks(wasmPath);
					const segmenter = await ImageSegmenter.createFromOptions(vision, {
						baseOptions: {
							modelAssetPath: modelPath,
							delegate: "CPU",
						},
						runningMode: "VIDEO",
						outputCategoryMask: false,
						outputConfidenceMasks: true,
					});
					segmentersByQuality.set(smartBackgroundQuality, segmenter);
					return true;
				} catch (error) {
					console.warn(
						"[webcam-smart-background] MediaPipe initialization failed",
						error,
					);
					return false;
				}
			})();

			preparePromisesByQuality.set(smartBackgroundQuality, preparePromise);
			void preparePromise.then((prepared) => {
				if (!prepared) {
					preparePromisesByQuality.delete(smartBackgroundQuality);
				}
			});
			return preparePromise;
		},
		isReady(quality) {
			return segmentersByQuality.has(normalizeSmartBackgroundQuality(quality));
		},
		render({
			source,
			sourceWidth,
			sourceHeight,
			outputCanvas,
			cropRegion,
			mirror = false,
			backgroundColor,
			backgroundPresetId,
			quality,
			timestampMs,
		}) {
			const smartBackgroundQuality = normalizeSmartBackgroundQuality(quality);
			const segmenter = segmentersByQuality.get(smartBackgroundQuality);
			if (
				!segmenter ||
				sourceWidth <= 0 ||
				sourceHeight <= 0 ||
				outputCanvas.width <= 0 ||
				outputCanvas.height <= 0
			) {
				return false;
			}

			const outputCtx = outputCanvas.getContext("2d");
			if (!outputCtx) {
				return false;
			}
			if (activeQuality !== smartBackgroundQuality) {
				activeQuality = smartBackgroundQuality;
				resetTemporalState();
			}

			const outputWidth = outputCanvas.width;
			const outputHeight = outputCanvas.height;
			ensureCanvasSize(workspace.frameCanvas, outputWidth, outputHeight);
			ensureCanvasSize(workspace.foregroundCanvas, outputWidth, outputHeight);

			workspace.frameCtx.clearRect(0, 0, outputWidth, outputHeight);
			drawCoveredSource(
				workspace.frameCtx,
				source,
				sourceWidth,
				sourceHeight,
				cropRegion,
				mirror,
				outputWidth,
				outputHeight,
			);

			const segmentationTimestampMs = getNextTimestamp(timestampMs);
			let result: ReturnType<ImageSegmenter["segmentForVideo"]>;
			try {
				result = segmenter.segmentForVideo(workspace.frameCanvas, segmentationTimestampMs);
			} catch (error) {
				console.warn("[webcam-smart-background] segmentation failed", error);
				resetTemporalState();
				return false;
			}

			const personMask =
				result.confidenceMasks?.[PERSON_CONFIDENCE_MASK_INDEX] ??
				result.confidenceMasks?.[0] ??
				null;
			if (!personMask) {
				result.close();
				return false;
			}
			const maskWidth = personMask.width;
			const maskHeight = personMask.height;

			const shouldSmooth =
				maskWidth === previousMaskWidth &&
				maskHeight === previousMaskHeight &&
				segmentationTimestampMs - lastSegmentationTimestampMs <= TEMPORAL_RESET_GAP_MS;

			ensureCanvasSize(workspace.maskCanvas, maskWidth, maskHeight);
			previousAlpha = drawMaskImageData(
				personMask,
				workspace.maskCtx,
				previousAlpha,
				shouldSmooth,
			);
			previousMaskWidth = maskWidth;
			previousMaskHeight = maskHeight;
			lastSegmentationTimestampMs = segmentationTimestampMs;
			result.close();

			if (!previousAlpha) {
				resetTemporalState();
				return false;
			}

			workspace.foregroundCtx.clearRect(0, 0, outputWidth, outputHeight);
			workspace.foregroundCtx.drawImage(workspace.frameCanvas, 0, 0);
			workspace.foregroundCtx.globalCompositeOperation = "destination-in";
			workspace.foregroundCtx.imageSmoothingEnabled = true;
			workspace.foregroundCtx.imageSmoothingQuality = "high";
			workspace.foregroundCtx.drawImage(
				workspace.maskCanvas,
				0,
				0,
				maskWidth,
				maskHeight,
				0,
				0,
				outputWidth,
				outputHeight,
			);
			workspace.foregroundCtx.globalCompositeOperation = "source-over";

			outputCtx.save();
			outputCtx.clearRect(0, 0, outputWidth, outputHeight);
			const preset = getWebcamSmartBackgroundPreset(backgroundPresetId);
			const backgroundImageState = backgroundImagesByPreset.get(preset.id);
			drawReplacementBackground(
				outputCtx,
				outputWidth,
				outputHeight,
				backgroundColor,
				backgroundPresetId,
				backgroundImageState?.ready ? backgroundImageState.image : undefined,
			);
			outputCtx.drawImage(workspace.foregroundCanvas, 0, 0);
			outputCtx.restore();
			return true;
		},
		close() {
			for (const segmenter of segmentersByQuality.values()) {
				segmenter.close();
			}
			segmentersByQuality.clear();
			preparePromisesByQuality.clear();
			backgroundImagesByPreset.clear();
			resetTemporalState();
		},
	};

	return renderer;
}
