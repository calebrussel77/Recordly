import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	rememberApprovedLocalReadPath: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: mocks.execFile,
}));

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getPath: () => process.env.RECORDLY_TEST_USER_DATA ?? os.tmpdir(),
		isPackaged: false,
	},
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock("../ffmpeg/binary", () => ({
	getFfmpegBinaryPath: () => "ffmpeg",
	getFfprobeBinaryPath: () => "ffprobe",
}));

vi.mock("../project/manager", () => ({
	rememberApprovedLocalReadPath: mocks.rememberApprovedLocalReadPath,
}));

import {
	buildAudioEnhancementCacheKey,
	buildEnhanceVoiceFilter,
	buildNoiseReductionFilter,
	enhanceSourceAudio,
	isEnhancedDurationAcceptable,
} from "./audioEnhancement";

const tempDirs: string[] = [];

async function makeTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-audio-enhancement-"));
	tempDirs.push(dir);
	process.env.RECORDLY_TEST_USER_DATA = dir;
	return dir;
}

beforeEach(() => {
	mocks.execFile.mockReset();
	mocks.rememberApprovedLocalReadPath.mockReset();
	delete process.env.RECORDLY_DEEP_FILTER_PATH;
});

afterEach(async () => {
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
	);
	delete process.env.RECORDLY_TEST_USER_DATA;
	delete process.env.RECORDLY_DEEP_FILTER_PATH;
});

function mockSuccessfulProcessing() {
	mocks.execFile.mockImplementation(
		(
			command: string,
			args: string[],
			_options: unknown,
			callback: (error?: Error | null) => void,
		) => {
			void (async () => {
				if (command === "ffprobe") {
					callback(null, "10.000000\n");
					return;
				}

				if (command === process.env.RECORDLY_DEEP_FILTER_PATH) {
					const outputDir = args[args.indexOf("-o") + 1];
					await fs.mkdir(outputDir, { recursive: true });
					await fs.writeFile(path.join(outputDir, "input.wav"), Buffer.alloc(128));
					callback(null);
					return;
				}

				const outputPath = args.at(-1);
				if (outputPath) {
					await fs.writeFile(outputPath, Buffer.alloc(128));
				}
				callback(null);
			})().catch((error) =>
				callback(error instanceof Error ? error : new Error(String(error))),
			);
		},
	);
}

describe("audio enhancement cache", () => {
	it("builds a stable cache key and invalidates when settings or source metadata change", () => {
		const base = {
			audioPath: "C:\\Recordly\\recording.mic.wav",
			size: 1200,
			mtimeMs: 1234.4,
			settings: { reduceNoise: true, enhanceVoice: true, enhanceVoiceIntensity: 75 },
		};

		const first = buildAudioEnhancementCacheKey(base);
		expect(buildAudioEnhancementCacheKey({ ...base })).toBe(first);
		expect(
			buildAudioEnhancementCacheKey({
				...base,
				settings: { ...base.settings, enhanceVoiceIntensity: 100 },
			}),
		).not.toBe(first);
		expect(buildAudioEnhancementCacheKey({ ...base, size: 1201 })).not.toBe(first);
	});

	it("keeps the processed signal dominant and never blends back raw audio", () => {
		// Intensity controls processing aggressiveness, not raw bleed: the wet
		// (processed) path stays >= 0.8 across the whole range so enhancement is
		// always clearly audible.
		expect(buildEnhanceVoiceFilter(0)).toContain("[wetp]volume=0.800");
		expect(buildEnhanceVoiceFilter(0)).toContain("volume=0.200[dryv]");
		expect(buildEnhanceVoiceFilter(75)).toContain("[wetp]volume=0.950");
		expect(buildEnhanceVoiceFilter(75)).toContain("volume=0.050[dryv]");
		expect(buildEnhanceVoiceFilter(75)).toContain("acompressor=threshold=0.080");
		expect(buildEnhanceVoiceFilter(75)).toContain("equalizer=f=3200");
		expect(buildEnhanceVoiceFilter(100)).toContain("[wetp]volume=1.000");
		expect(buildEnhanceVoiceFilter(100)).toContain("volume=0.000[dryv]");
	});

	it("cleans the dry residue and loudness-normalizes the final mix", () => {
		// Even the residual dry path is high-passed + lightly denoised so it can
		// never reintroduce hiss/rumble.
		expect(buildEnhanceVoiceFilter(75)).toContain("[dry]highpass=f=80,afftdn=nr=6");
		// The final mix is normalized to a consistent EBU R128 target instead of a
		// flat gain multiplier.
		expect(buildEnhanceVoiceFilter(75)).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
	});

	it("builds stronger fallback and residual noise cleanup filters", () => {
		expect(buildNoiseReductionFilter("fallback")).toContain("afftdn=nr=24");
		expect(buildNoiseReductionFilter("fallback")).toContain("anlmdn");
		expect(buildNoiseReductionFilter("fallback")).toContain("agate=threshold=0.018");
		expect(buildNoiseReductionFilter("residual")).toContain("afftdn=nr=10");
		expect(buildNoiseReductionFilter("residual")).not.toContain("anlmdn");
	});

	it("rejects enhanced outputs that are meaningfully shorter than the source", () => {
		expect(
			isEnhancedDurationAcceptable({
				sourceDurationSeconds: 56.223,
				outputDurationSeconds: 56.193,
			}),
		).toBe(true);
		expect(
			isEnhancedDurationAcceptable({
				sourceDurationSeconds: 56.223,
				outputDurationSeconds: 48,
			}),
		).toBe(false);
	});
});

describe("enhanceSourceAudio", () => {
	it("normalizes to WAV, runs deep-filter, caches the output, and approves local playback", async () => {
		const dir = await makeTempDir();
		const sourcePath = path.join(dir, "recording.mic.wav");
		const deepFilterPath = path.join(dir, "deep-filter.exe");
		await fs.writeFile(sourcePath, Buffer.alloc(256));
		await fs.writeFile(deepFilterPath, "binary");
		process.env.RECORDLY_DEEP_FILTER_PATH = deepFilterPath;
		mockSuccessfulProcessing();

		const result = await enhanceSourceAudio({
			audioPath: sourcePath,
			settings: { reduceNoise: true, enhanceVoice: true, enhanceVoiceIntensity: 75 },
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.path).toContain("audio-enhancement-cache");
			await expect(fs.stat(result.path)).resolves.toBeTruthy();
			expect(mocks.rememberApprovedLocalReadPath).toHaveBeenCalledWith(result.path);
		}
		expect(mocks.execFile).toHaveBeenCalledWith(
			"ffmpeg",
			expect.arrayContaining(["-ac", "1", "-ar", "48000"]),
			expect.any(Object),
			expect.any(Function),
		);
		expect(mocks.execFile).toHaveBeenCalledWith(
			deepFilterPath,
			expect.arrayContaining(["-D", "--pf", "--pf-beta", "0.08"]),
			expect.any(Object),
			expect.any(Function),
		);
		expect(mocks.execFile).toHaveBeenCalledWith(
			"ffmpeg",
			expect.arrayContaining(["-filter_complex", expect.stringContaining("afftdn=nr=10")]),
			expect.any(Object),
			expect.any(Function),
		);
	});

	it("falls back to FFmpeg denoise when deep-filter fails", async () => {
		const dir = await makeTempDir();
		const sourcePath = path.join(dir, "recording.mic.wav");
		const deepFilterPath = path.join(dir, "deep-filter.exe");
		await fs.writeFile(sourcePath, Buffer.alloc(256));
		await fs.writeFile(deepFilterPath, "binary");
		process.env.RECORDLY_DEEP_FILTER_PATH = deepFilterPath;

		mocks.execFile.mockImplementation(
			(
				command: string,
				args: string[],
				_options: unknown,
				callback: (error?: Error | null) => void,
			) => {
				void (async () => {
					if (command === deepFilterPath) {
						callback(new Error("deep-filter failed"));
						return;
					}
					if (command === "ffprobe") {
						callback(null, "10.000000\n");
						return;
					}
					const outputPath = args.at(-1);
					if (outputPath) {
						await fs.writeFile(outputPath, Buffer.alloc(128));
					}
					callback(null);
				})().catch((error) =>
					callback(error instanceof Error ? error : new Error(String(error))),
				);
			},
		);

		const result = await enhanceSourceAudio({
			audioPath: sourcePath,
			settings: { reduceNoise: true, enhanceVoice: false },
		});

		expect(result.success).toBe(true);
		expect(mocks.execFile).toHaveBeenCalledWith(
			"ffmpeg",
			expect.arrayContaining(["-filter_complex", expect.stringContaining("anlmdn")]),
			expect.any(Object),
			expect.any(Function),
		);
	});

	it("rejects truncated processed audio so callers can fall back to the original", async () => {
		const dir = await makeTempDir();
		const sourcePath = path.join(dir, "recording.mic.wav");
		await fs.writeFile(sourcePath, Buffer.alloc(256));

		mocks.execFile.mockImplementation(
			(
				command: string,
				args: string[],
				_options: unknown,
				callback: (error?: Error | null, stdout?: string) => void,
			) => {
				void (async () => {
					if (command === "ffprobe") {
						const filePath = args.at(-1) ?? "";
						callback(
							null,
							filePath.includes("polished.wav") ? "4.000000\n" : "10.000000\n",
						);
						return;
					}
					const outputPath = args.at(-1);
					if (outputPath) {
						await fs.writeFile(outputPath, Buffer.alloc(128));
					}
					callback(null);
				})().catch((error) =>
					callback(error instanceof Error ? error : new Error(String(error))),
				);
			},
		);

		const result = await enhanceSourceAudio({
			audioPath: sourcePath,
			settings: { reduceNoise: false, enhanceVoice: true, enhanceVoiceIntensity: 75 },
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("duration is invalid");
		}
	});
});
