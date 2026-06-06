import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RECORDING_SESSION_MANIFEST_SUFFIX } from "../constants";
import type { RecordingSessionData, RecordingSessionManifest } from "../types";
import { normalizeVideoSourcePath, parseJsonWithByteOrderMark } from "../utils";

function normalizeRecordingTimeOffsetMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function normalizeAudioStartDelayMs(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: null;
}

export function getRecordingSessionManifestPath(videoPath: string) {
	const extension = path.extname(videoPath);
	const baseName = path.basename(videoPath, extension);
	return path.join(path.dirname(videoPath), `${baseName}${RECORDING_SESSION_MANIFEST_SUFFIX}`);
}

/**
 * Merge the recorder-provided source-audio sidecars (e.g. the microphone
 * sidecar, whose start-delay timing is authoritative) with additional ones
 * discovered on disk (e.g. a sibling `recording-*.system.wav` written by native
 * capture that the recorder never listed). De-duplicates by path, keeps the base
 * ordering first, and prefers the base timing over the discovered timing. This
 * stops the editor from silently dropping a real companion track in preview and
 * export.
 */
export function mergeSourceAudioFallbackPaths(
	base: { paths: string[]; startDelayMsByPath: Record<string, number> },
	additional: { paths: string[]; startDelayMsByPath: Record<string, number> },
): { paths: string[]; startDelayMsByPath: Record<string, number> } {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const audioPath of [...base.paths, ...additional.paths]) {
		if (!audioPath || seen.has(audioPath)) {
			continue;
		}
		seen.add(audioPath);
		paths.push(audioPath);
	}

	const startDelayMsByPath: Record<string, number> = {};
	for (const audioPath of paths) {
		const delayMs = normalizeAudioStartDelayMs(
			base.startDelayMsByPath[audioPath] ?? additional.startDelayMsByPath[audioPath],
		);
		if (delayMs !== null) {
			startDelayMsByPath[audioPath] = delayMs;
		}
	}

	return { paths, startDelayMsByPath };
}

export async function persistRecordingSessionManifest(
	session: RecordingSessionData,
): Promise<void> {
	const normalizedVideoPath = normalizeVideoSourcePath(session.videoPath);
	if (!normalizedVideoPath) {
		return;
	}

	const normalizedWebcamPath = normalizeVideoSourcePath(session.webcamPath ?? null);
	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);
	const videoDir = path.dirname(normalizedVideoPath);
	const sourceAudioFallbackPaths = (session.sourceAudioFallbackPaths ?? [])
		.map((audioPath) => normalizeVideoSourcePath(audioPath))
		.filter((audioPath): audioPath is string => Boolean(audioPath))
		.filter((audioPath) => path.dirname(audioPath) === videoDir);

	if (!normalizedWebcamPath && sourceAudioFallbackPaths.length === 0) {
		await fs.rm(manifestPath, { force: true });
		return;
	}

	const sourceAudioFallbackStartDelayMsByFileName: Record<string, number> = {};
	for (const audioPath of sourceAudioFallbackPaths) {
		const delayMs = normalizeAudioStartDelayMs(
			session.sourceAudioFallbackStartDelayMsByPath?.[audioPath],
		);
		if (delayMs !== null) {
			sourceAudioFallbackStartDelayMsByFileName[path.basename(audioPath)] = delayMs;
		}
	}

	const manifest: RecordingSessionManifest = {
		version: 3,
		videoFileName: path.basename(normalizedVideoPath),
		webcamFileName: normalizedWebcamPath ? path.basename(normalizedWebcamPath) : null,
		timeOffsetMs: normalizeRecordingTimeOffsetMs(session.timeOffsetMs),
		sourceAudioFallbackFileNames:
			sourceAudioFallbackPaths.length > 0
				? sourceAudioFallbackPaths.map((audioPath) => path.basename(audioPath))
				: undefined,
		sourceAudioFallbackStartDelayMsByFileName:
			Object.keys(sourceAudioFallbackStartDelayMsByFileName).length > 0
				? sourceAudioFallbackStartDelayMsByFileName
				: undefined,
	};

	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

export async function resolveRecordingSessionManifest(
	videoPath?: string | null,
): Promise<RecordingSessionData | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);

	try {
		const content = await fs.readFile(manifestPath, "utf-8");
		const parsed = parseJsonWithByteOrderMark<Partial<RecordingSessionManifest>>(content);
		if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
			return null;
		}

		const videoDir = path.dirname(normalizedVideoPath);
		const sourceAudioFallbackPaths: string[] = [];
		const sourceAudioFallbackStartDelayMsByPath: Record<string, number> = {};
		const sourceAudioFallbackFileNames = Array.isArray(parsed.sourceAudioFallbackFileNames)
			? parsed.sourceAudioFallbackFileNames
			: [];

		for (const audioFileName of sourceAudioFallbackFileNames) {
			if (
				typeof audioFileName !== "string" ||
				path.basename(audioFileName) !== audioFileName
			) {
				continue;
			}

			const audioPath = path.join(videoDir, audioFileName);
			const audioExists = await fs
				.access(audioPath, fsConstants.F_OK)
				.then(() => true)
				.catch(() => false);
			if (!audioExists) {
				continue;
			}

			sourceAudioFallbackPaths.push(audioPath);
			const delayMs = normalizeAudioStartDelayMs(
				parsed.sourceAudioFallbackStartDelayMsByFileName?.[audioFileName],
			);
			if (delayMs !== null) {
				sourceAudioFallbackStartDelayMsByPath[audioPath] = delayMs;
			}
		}

		const webcamFileName =
			typeof parsed.webcamFileName === "string" && parsed.webcamFileName.trim()
				? parsed.webcamFileName.trim()
				: null;

		if (!webcamFileName) {
			return {
				videoPath: normalizedVideoPath,
				webcamPath: null,
				timeOffsetMs: normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs),
				sourceAudioFallbackPaths,
				sourceAudioFallbackStartDelayMsByPath,
			};
		}

		const webcamPath = path.join(path.dirname(normalizedVideoPath), webcamFileName);
		const webcamExists = await fs
			.access(webcamPath, fsConstants.F_OK)
			.then(() => true)
			.catch(() => false);

		return {
			videoPath: normalizedVideoPath,
			webcamPath: webcamExists ? webcamPath : null,
			timeOffsetMs: normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs),
			sourceAudioFallbackPaths,
			sourceAudioFallbackStartDelayMsByPath,
		};
	} catch {
		return null;
	}
}

export async function resolveLinkedWebcamPath(videoPath?: string | null): Promise<string | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const extension = path.extname(normalizedVideoPath);
	const baseName = path.basename(normalizedVideoPath, extension);
	if (!baseName || baseName.endsWith("-webcam")) {
		return null;
	}

	const candidateExtensions = Array.from(
		new Set([extension, ".webm", ".mp4", ".mov", ".mkv", ".avi"].filter(Boolean)),
	);

	for (const candidateExtension of candidateExtensions) {
		const candidatePath = path.join(
			path.dirname(normalizedVideoPath),
			`${baseName}-webcam${candidateExtension}`,
		);

		try {
			await fs.access(candidatePath, fsConstants.F_OK);
			return candidatePath;
		} catch {
			continue;
		}
	}

	return null;
}

export async function resolveRecordingSession(
	videoPath?: string | null,
): Promise<RecordingSessionData | null> {
	const manifestSession = await resolveRecordingSessionManifest(videoPath);
	if (manifestSession) {
		return manifestSession;
	}

	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const linkedWebcamPath = await resolveLinkedWebcamPath(normalizedVideoPath);
	return {
		videoPath: normalizedVideoPath,
		webcamPath: linkedWebcamPath,
	};
}
