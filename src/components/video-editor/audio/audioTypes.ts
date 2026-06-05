import type { AudioPeaksData } from "../timeline/core/timelineTypes";

export type SourceAudioTrackId = "mixed" | "system" | "mic" | (string & {});

export interface SourceAudioTrackSetting {
	volume: number;
	normalize: boolean;
	reduceNoise?: boolean;
	enhanceVoice?: boolean;
	enhanceVoiceIntensity?: number;
}

export type SourceAudioTrackSettings = Record<string, SourceAudioTrackSetting>;

export interface SourceAudioTrackMetaItem {
	id: SourceAudioTrackId;
	label: string;
}

export type SourceAudioTrackMeta = SourceAudioTrackMetaItem[];

export interface SourceAudioTrackWithPeaks extends SourceAudioTrackMetaItem {
	peaks: AudioPeaksData;
}

export const SOURCE_AUDIO_FALLBACK_TOAST_ID = "source-audio-fallback-error";
export const SOURCE_AUDIO_NORMALIZE_GAIN = 1.35;
export const DEFAULT_ENHANCE_VOICE_INTENSITY = 75;

export function normalizeSourceAudioTrackSetting(
	setting?: Partial<SourceAudioTrackSetting> | null,
): SourceAudioTrackSetting {
	const volume =
		typeof setting?.volume === "number" && Number.isFinite(setting.volume)
			? Math.max(0, Math.min(1, setting.volume))
			: 1;
	const intensity =
		typeof setting?.enhanceVoiceIntensity === "number" &&
		Number.isFinite(setting.enhanceVoiceIntensity)
			? Math.max(0, Math.min(100, Math.round(setting.enhanceVoiceIntensity)))
			: DEFAULT_ENHANCE_VOICE_INTENSITY;

	return {
		volume,
		normalize: Boolean(setting?.normalize),
		reduceNoise: Boolean(setting?.reduceNoise),
		enhanceVoice: Boolean(setting?.enhanceVoice),
		enhanceVoiceIntensity: intensity,
	};
}

export function isSourceAudioEnhancementEnabled(setting?: Partial<SourceAudioTrackSetting> | null) {
	return Boolean(setting?.reduceNoise || setting?.enhanceVoice);
}
