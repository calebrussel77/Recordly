import {
	isSourceAudioEnhancementEnabled,
	normalizeSourceAudioTrackSetting,
	type SourceAudioTrackSettings,
} from "@/components/video-editor/audio/audioTypes";
import { getSourceTrackIdFromPath, type SourceTrackId } from "@/lib/exporter/audioRoutingEngine";

export interface EnhancedSourceAudioPaths {
	paths: string[];
	startDelayMsByPath: Record<string, number>;
}

function isEnhanceableSourceTrack(trackId: SourceTrackId, sourcePaths: string[]) {
	if (trackId === "mic") {
		return true;
	}
	const hasMicTrack = sourcePaths.some(
		(sourcePath) => getSourceTrackIdFromPath(sourcePath) === "mic",
	);
	return trackId === "mixed" && !hasMicTrack;
}

export function getEnhancementSettingsForSourcePath(
	audioPath: string,
	sourcePaths: string[],
	sourceAudioTrackSettings?: SourceAudioTrackSettings,
) {
	const trackId = getSourceTrackIdFromPath(audioPath);
	if (!isEnhanceableSourceTrack(trackId, sourcePaths)) {
		return null;
	}
	const settings = normalizeSourceAudioTrackSetting(sourceAudioTrackSettings?.[trackId]);
	return isSourceAudioEnhancementEnabled(settings) ? settings : null;
}

export async function enhanceSourceAudioPath(
	audioPath: string,
	sourcePaths: string[],
	sourceAudioTrackSettings?: SourceAudioTrackSettings,
) {
	const settings = getEnhancementSettingsForSourcePath(
		audioPath,
		sourcePaths,
		sourceAudioTrackSettings,
	);
	if (!settings || typeof window === "undefined" || !window.electronAPI?.enhanceSourceAudio) {
		return audioPath;
	}

	try {
		const result = await window.electronAPI.enhanceSourceAudio({ audioPath, settings });
		if (result.success && result.path) {
			return result.path;
		}
		console.warn("[audio-enhancement] Failed to enhance source audio", result);
	} catch (error) {
		console.warn("[audio-enhancement] Failed to enhance source audio", error);
	}
	return audioPath;
}

export async function enhanceSourceAudioPathsForExport(input: {
	paths: string[];
	startDelayMsByPath?: Record<string, number>;
	sourceAudioTrackSettings?: SourceAudioTrackSettings;
}): Promise<EnhancedSourceAudioPaths> {
	const paths = input.paths.filter((audioPath) => audioPath.trim().length > 0);
	const enhancedPaths: string[] = [];
	const enhancedDelayByPath: Record<string, number> = {};

	for (const audioPath of paths) {
		const enhancedPath = await enhanceSourceAudioPath(
			audioPath,
			paths,
			input.sourceAudioTrackSettings,
		);
		enhancedPaths.push(enhancedPath);
		const delayMs = input.startDelayMsByPath?.[audioPath];
		if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
			enhancedDelayByPath[enhancedPath] = delayMs;
		}
	}

	return {
		paths: enhancedPaths,
		startDelayMsByPath: enhancedDelayByPath,
	};
}
