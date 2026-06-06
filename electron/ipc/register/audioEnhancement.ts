import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, ipcMain } from "electron";
import { getFfmpegBinaryPath, getFfprobeBinaryPath } from "../ffmpeg/binary";
import { getPrebundledNativeHelperPath } from "../paths/binaries";
import { rememberApprovedLocalReadPath } from "../project/manager";
import { normalizeVideoSourcePath } from "../utils";

const execFileAsync = promisify(execFile);

export const AUDIO_ENHANCEMENT_ENGINE_VERSION = "deepfilter-0.5.6-ffmpeg-v2";
const DEFAULT_ENHANCE_VOICE_INTENSITY = 75;
const DEEPFILTER_POST_FILTER_BETA = "0.08";

export interface AudioEnhancementSettings {
	reduceNoise?: boolean;
	enhanceVoice?: boolean;
	enhanceVoiceIntensity?: number;
}

export interface EnhanceSourceAudioOptions {
	audioPath: string;
	settings?: AudioEnhancementSettings | null;
}

export type EnhanceSourceAudioResult =
	| {
			success: true;
			path: string;
			diagnostics?: Record<string, unknown>;
	  }
	| {
			success: false;
			error: string;
			diagnostics?: Record<string, unknown>;
	  };

interface NormalizedAudioEnhancementSettings {
	reduceNoise: boolean;
	enhanceVoice: boolean;
	enhanceVoiceIntensity: number;
}

function normalizeAudioEnhancementSettings(
	settings?: AudioEnhancementSettings | null,
): NormalizedAudioEnhancementSettings {
	const intensity =
		typeof settings?.enhanceVoiceIntensity === "number" &&
		Number.isFinite(settings.enhanceVoiceIntensity)
			? Math.max(0, Math.min(100, Math.round(settings.enhanceVoiceIntensity)))
			: DEFAULT_ENHANCE_VOICE_INTENSITY;

	return {
		reduceNoise: Boolean(settings?.reduceNoise),
		enhanceVoice: Boolean(settings?.enhanceVoice),
		enhanceVoiceIntensity: intensity,
	};
}

export function isAudioEnhancementEnabled(settings?: AudioEnhancementSettings | null) {
	const normalized = normalizeAudioEnhancementSettings(settings);
	return normalized.reduceNoise || normalized.enhanceVoice;
}

function getAudioEnhancementCacheDir() {
	return path.join(app.getPath("userData"), "audio-enhancement-cache");
}

function toStableSourcePath(filePath: string) {
	return process.platform === "win32"
		? path.resolve(filePath).toLowerCase()
		: path.resolve(filePath);
}

function safeBaseName(filePath: string) {
	return path
		.basename(filePath, path.extname(filePath))
		.replace(/[^a-z0-9._-]+/gi, "-")
		.slice(0, 90);
}

export function buildAudioEnhancementCacheKey(input: {
	audioPath: string;
	size: number;
	mtimeMs: number;
	settings?: AudioEnhancementSettings | null;
}) {
	const settings = normalizeAudioEnhancementSettings(input.settings);
	return createHash("sha256")
		.update(
			JSON.stringify({
				engineVersion: AUDIO_ENHANCEMENT_ENGINE_VERSION,
				audioPath: toStableSourcePath(input.audioPath),
				size: input.size,
				mtimeMs: Math.round(input.mtimeMs),
				settings,
			}),
		)
		.digest("hex")
		.slice(0, 24);
}

function getDeepFilterBinaryCandidates() {
	const binaryName = process.platform === "win32" ? "deep-filter.exe" : "deep-filter";
	return [
		process.env.RECORDLY_DEEP_FILTER_PATH,
		getPrebundledNativeHelperPath(binaryName),
		process.platform === "win32" ? "deep-filter.exe" : "deep-filter",
	].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveDeepFilterBinary() {
	for (const candidate of getDeepFilterBinaryCandidates()) {
		if (candidate === "deep-filter" || candidate === "deep-filter.exe") {
			return candidate;
		}
		if (fsSync.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function runCommand(command: string, args: string[]) {
	await execFileAsync(command, args, {
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	});
}

async function runCommandWithOutput(command: string, args: string[]) {
	const result = await execFileAsync(command, args, {
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (typeof result === "string") {
		return { stdout: result, stderr: "" };
	}
	return result;
}

async function probeAudioDurationSeconds(filePath: string): Promise<number | null> {
	try {
		const { stdout } = await runCommandWithOutput(getFfprobeBinaryPath(), [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			filePath,
		]);
		const duration = Number.parseFloat(String(stdout).trim());
		return Number.isFinite(duration) && duration > 0 ? duration : null;
	} catch {
		return null;
	}
}

function getDurationMismatchToleranceSeconds(sourceDurationSeconds: number) {
	return Math.min(2, Math.max(0.35, sourceDurationSeconds * 0.005));
}

export function isEnhancedDurationAcceptable(input: {
	sourceDurationSeconds?: number | null;
	outputDurationSeconds?: number | null;
}) {
	const sourceDurationSeconds = input.sourceDurationSeconds;
	const outputDurationSeconds = input.outputDurationSeconds;
	if (!Number.isFinite(outputDurationSeconds) || (outputDurationSeconds ?? 0) <= 0) {
		return false;
	}

	if (!Number.isFinite(sourceDurationSeconds) || (sourceDurationSeconds ?? 0) <= 0) {
		return true;
	}

	const missingDurationSeconds = (sourceDurationSeconds ?? 0) - (outputDurationSeconds ?? 0);
	return (
		missingDurationSeconds <= getDurationMismatchToleranceSeconds(sourceDurationSeconds ?? 0)
	);
}

async function convertToWav48kMono(inputPath: string, outputPath: string) {
	await runCommand(getFfmpegBinaryPath(), [
		"-y",
		"-hide_banner",
		"-nostdin",
		"-nostats",
		"-i",
		inputPath,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"48000",
		"-c:a",
		"pcm_s16le",
		outputPath,
	]);
}

export function buildEnhanceVoiceFilter(intensity: number) {
	const wetGain = Math.max(0, Math.min(1, intensity / 100));
	const dryGain = Math.max(0, Math.min(1, 1 - wetGain));
	const presenceGain = 1.1 + wetGain * 1.4;
	const airGain = 0.5 + wetGain * 1.1;
	const compressorThreshold = 0.11 - wetGain * 0.04;
	const compressorRatio = 2.2 + wetGain * 1.4;
	const compressorMakeup = 1.08 + wetGain * 0.24;
	const cleanupNoiseReduction = 4 + wetGain * 6;
	return [
		"[0:a]asplit=2[dry][wet]",
		[
			"[wet]adeclick=w=50:o=75:t=4:b=2",
			`afftdn=nr=${cleanupNoiseReduction.toFixed(1)}:nf=-55:tn=1:rf=-48:ad=0.70:gs=8`,
			"deesser=i=0.35:m=0.55:f=0.45",
			"highpass=f=80",
			"lowpass=f=13000",
			"equalizer=f=180:t=q:w=1.1:g=-1.5",
			`equalizer=f=3200:t=q:w=1.1:g=${presenceGain.toFixed(2)}`,
			`equalizer=f=9000:t=q:w=1.4:g=${airGain.toFixed(2)}`,
			`acompressor=threshold=${compressorThreshold.toFixed(3)}:ratio=${compressorRatio.toFixed(3)}:attack=7:release=140:makeup=${compressorMakeup.toFixed(2)}:knee=3:detection=rms`,
			"speechnorm=p=0.92:e=18:c=2:r=0.0005:f=0.001",
			"alimiter=limit=0.90:level=0[wetp]",
		].join(","),
		`[dry]volume=${dryGain.toFixed(3)}[dryv]`,
		`[wetp]volume=${wetGain.toFixed(3)}[wetv]`,
		"[dryv][wetv]amix=inputs=2:normalize=0,alimiter=limit=0.90:level=0,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout]",
	].join(";");
}

export function buildNoiseReductionFilter(mode: "fallback" | "residual" = "fallback") {
	const isResidual = mode === "residual";
	const stages = [
		"highpass=f=80",
		"lowpass=f=12000",
		isResidual
			? "afftdn=nr=10:nf=-55:tn=1:rf=-48:ad=0.70:gs=8"
			: "afftdn=nr=24:nf=-52:tn=1:rf=-45:ad=0.85:gs=12",
	];

	if (!isResidual) {
		stages.push("anlmdn=s=0.00008:p=0.002:r=0.008:m=15");
	}

	stages.push(
		isResidual
			? "agate=threshold=0.012:ratio=2.0:range=0.18:attack=10:release=160:detection=rms"
			: "agate=threshold=0.018:ratio=2.5:range=0.25:attack=8:release=140:detection=rms",
		"alimiter=limit=0.90:level=0",
		"aresample=async=1:first_pts=0",
		"asetpts=PTS-STARTPTS[aout]",
	);

	return `[0:a]${stages.join(",")}`;
}

async function runFfmpegFilter(inputPath: string, outputPath: string, filter: string) {
	await runCommand(getFfmpegBinaryPath(), [
		"-y",
		"-hide_banner",
		"-nostdin",
		"-nostats",
		"-i",
		inputPath,
		"-filter_complex",
		filter,
		"-map",
		"[aout]",
		"-ac",
		"1",
		"-ar",
		"48000",
		"-c:a",
		"pcm_s16le",
		outputPath,
	]);
}

async function runNoiseFallback(inputPath: string, outputPath: string) {
	await runFfmpegFilter(inputPath, outputPath, buildNoiseReductionFilter("fallback"));
}

async function runResidualNoiseCleanup(inputPath: string, outputPath: string) {
	await runFfmpegFilter(inputPath, outputPath, buildNoiseReductionFilter("residual"));
}

async function runEnhanceVoice(inputPath: string, outputPath: string, intensity: number) {
	await runFfmpegFilter(inputPath, outputPath, buildEnhanceVoiceFilter(intensity));
}

async function findFirstWavFile(dir: string) {
	const entries = await fs.readdir(dir);
	const wav = entries.find((entry) => entry.toLowerCase().endsWith(".wav"));
	return wav ? path.join(dir, wav) : null;
}

async function runDeepFilter(inputPath: string, workDir: string) {
	const binary = resolveDeepFilterBinary();
	if (!binary) {
		return { path: null, error: "deep-filter binary not found" };
	}

	const outputDir = path.join(workDir, "deepfilter-output");
	await fs.mkdir(outputDir, { recursive: true });
	await runCommand(binary, [
		"-D",
		"--pf",
		"--pf-beta",
		DEEPFILTER_POST_FILTER_BETA,
		"-o",
		outputDir,
		inputPath,
	]);
	return { path: await findFirstWavFile(outputDir), error: null };
}

async function fileExistsWithAudioData(filePath: string) {
	try {
		const stat = await fs.stat(filePath);
		return stat.size > 44;
	} catch {
		return false;
	}
}

export async function enhanceSourceAudio(
	options: EnhanceSourceAudioOptions,
): Promise<EnhanceSourceAudioResult> {
	const audioPath = normalizeVideoSourcePath(options.audioPath);
	if (!audioPath) {
		return { success: false, error: "Invalid audio path" };
	}

	const settings = normalizeAudioEnhancementSettings(options.settings);
	if (!settings.reduceNoise && !settings.enhanceVoice) {
		await rememberApprovedLocalReadPath(audioPath);
		return {
			success: true,
			path: audioPath,
			diagnostics: { cacheHit: false, bypassed: true },
		};
	}

	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(audioPath);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Source audio not found",
		};
	}
	const sourceDurationSeconds = await probeAudioDurationSeconds(audioPath);

	const cacheDir = getAudioEnhancementCacheDir();
	await fs.mkdir(cacheDir, { recursive: true });
	const cacheKey = buildAudioEnhancementCacheKey({
		audioPath,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		settings,
	});
	const cachedPath = path.join(cacheDir, `${safeBaseName(audioPath)}.${cacheKey}.enhanced.wav`);
	if (await fileExistsWithAudioData(cachedPath)) {
		const cachedDurationSeconds = await probeAudioDurationSeconds(cachedPath);
		if (
			isEnhancedDurationAcceptable({
				sourceDurationSeconds,
				outputDurationSeconds: cachedDurationSeconds,
			})
		) {
			await rememberApprovedLocalReadPath(cachedPath);
			return {
				success: true,
				path: cachedPath,
				diagnostics: {
					cacheHit: true,
					engineVersion: AUDIO_ENHANCEMENT_ENGINE_VERSION,
					sourceDurationSeconds,
					outputDurationSeconds: cachedDurationSeconds,
				},
			};
		}
		await fs.rm(cachedPath, { force: true });
	}

	const workDir = await fs.mkdtemp(path.join(cacheDir, `${cacheKey}-`));
	const normalizedPath = path.join(workDir, "input.wav");
	const denoisedPath = path.join(workDir, "denoised.wav");
	const residualDenoisedPath = path.join(workDir, "denoised-residual.wav");
	const polishedPath = path.join(workDir, "polished.wav");
	const tempOutputPath = path.join(workDir, "enhanced.wav");
	const diagnostics: Record<string, unknown> = {
		cacheHit: false,
		engineVersion: AUDIO_ENHANCEMENT_ENGINE_VERSION,
		reduceNoiseApplied: settings.reduceNoise,
		enhanceVoiceApplied: settings.enhanceVoice,
		enhanceVoiceIntensity: settings.enhanceVoiceIntensity,
		sourceDurationSeconds,
	};

	try {
		await convertToWav48kMono(audioPath, normalizedPath);

		let currentPath = normalizedPath;
		if (settings.reduceNoise) {
			try {
				const deepFilterResult = await runDeepFilter(normalizedPath, workDir);
				if (deepFilterResult.path) {
					currentPath = deepFilterResult.path;
					diagnostics.noiseReductionEngine = "deepfilter";
					diagnostics.deepFilterPostFilter = true;
				} else {
					throw new Error(deepFilterResult.error ?? "deep-filter produced no wav");
				}
			} catch (error) {
				diagnostics.noiseReductionEngine = "ffmpeg-fallback";
				diagnostics.deepFilterError =
					error instanceof Error ? error.message : String(error);
				await runNoiseFallback(normalizedPath, denoisedPath);
				currentPath = denoisedPath;
			}

			if (diagnostics.noiseReductionEngine === "deepfilter") {
				await runResidualNoiseCleanup(currentPath, residualDenoisedPath);
				currentPath = residualDenoisedPath;
				diagnostics.residualNoiseCleanup = "ffmpeg";
			}
		}

		if (settings.enhanceVoice) {
			await runEnhanceVoice(currentPath, polishedPath, settings.enhanceVoiceIntensity);
			currentPath = polishedPath;
		}

		const outputDurationSeconds = await probeAudioDurationSeconds(currentPath);
		diagnostics.outputDurationSeconds = outputDurationSeconds;
		if (
			!isEnhancedDurationAcceptable({
				sourceDurationSeconds,
				outputDurationSeconds,
			})
		) {
			throw new Error(
				`Enhanced audio duration is invalid (${outputDurationSeconds ?? "unknown"}s for source ${sourceDurationSeconds ?? "unknown"}s)`,
			);
		}

		await fs.copyFile(currentPath, tempOutputPath);
		await fs.rm(cachedPath, { force: true });
		await fs.rename(tempOutputPath, cachedPath);
		await rememberApprovedLocalReadPath(cachedPath);
		return { success: true, path: cachedPath, diagnostics };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			diagnostics,
		};
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}

export function registerAudioEnhancementHandlers() {
	ipcMain.handle(
		"enhance-source-audio",
		async (_event, options: EnhanceSourceAudioOptions): Promise<EnhanceSourceAudioResult> =>
			enhanceSourceAudio(options),
	);
}
