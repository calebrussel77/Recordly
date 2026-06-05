import React, { useCallback, useMemo, useState } from "react";
import type {
	SourceAudioTrackId,
	SourceAudioTrackMeta,
	SourceAudioTrackSetting,
	SourceAudioTrackSettings,
} from "@/components/video-editor/audio/audioTypes";
import { normalizeSourceAudioTrackSetting } from "@/components/video-editor/audio/audioTypes";

interface UseSourceAudioTrackSettingsParams {
	selectedClipId: string | null;
	activeClipId: string | null;
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
}

export interface UseSourceAudioTrackSettingsResult {
	sourceAudioTrackMeta: SourceAudioTrackMeta;
	activeSourceAudioTrackSettings: SourceAudioTrackSettings;
	selectedClipSourceAudioTrackSettings: SourceAudioTrackSettings;
	getSourceAudioTrackSettingsForClip: (clipId: string | null) => SourceAudioTrackSettings;
	onSourceAudioTracksMetaChange: (tracks: SourceAudioTrackMeta) => void;
	onSelectedClipSourceAudioTrackVolumeChange: (id: string, volume: number) => void;
	onSelectedClipSourceAudioTrackNormalizeChange: (id: string, normalize: boolean) => void;
	onSelectedClipSourceAudioTrackReduceNoiseChange: (id: string, reduceNoise: boolean) => void;
	onSelectedClipSourceAudioTrackEnhanceVoiceChange: (id: string, enhanceVoice: boolean) => void;
	onSelectedClipSourceAudioTrackEnhanceVoiceIntensityChange: (
		id: string,
		intensity: number,
	) => void;
}

function normalizeSetting(setting?: Partial<SourceAudioTrackSetting> | null) {
	return normalizeSourceAudioTrackSetting(setting);
}

function areSettingsEqual(left: SourceAudioTrackSetting, right: SourceAudioTrackSetting) {
	return (
		left.volume === right.volume &&
		left.normalize === right.normalize &&
		Boolean(left.reduceNoise) === Boolean(right.reduceNoise) &&
		Boolean(left.enhanceVoice) === Boolean(right.enhanceVoice) &&
		(left.enhanceVoiceIntensity ?? 75) === (right.enhanceVoiceIntensity ?? 75)
	);
}

function isSameTrackMeta(left: SourceAudioTrackMeta, right: SourceAudioTrackMeta): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftTrack = left[index];
		const rightTrack = right[index];
		if (!leftTrack || !rightTrack) return false;
		if (leftTrack.id !== rightTrack.id || leftTrack.label !== rightTrack.label) {
			return false;
		}
	}
	return true;
}

export function useSourceAudioTrackSettings({
	selectedClipId,
	activeClipId,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
}: UseSourceAudioTrackSettingsParams): UseSourceAudioTrackSettingsResult {
	const [sourceAudioTrackMeta, setSourceAudioTrackMeta] = useState<SourceAudioTrackMeta>([]);

	const activeSourceAudioTrackSettings = useMemo(() => {
		if (!activeClipId) {
			return defaultSourceAudioTrackSettings;
		}
		return {
			...defaultSourceAudioTrackSettings,
			...(sourceAudioTrackSettingsByClip[activeClipId] ?? {}),
		};
	}, [activeClipId, defaultSourceAudioTrackSettings, sourceAudioTrackSettingsByClip]);

	const selectedClipSourceAudioTrackSettings = useMemo(() => {
		if (!selectedClipId) {
			return defaultSourceAudioTrackSettings;
		}
		return {
			...defaultSourceAudioTrackSettings,
			...(sourceAudioTrackSettingsByClip[selectedClipId] ?? {}),
		};
	}, [defaultSourceAudioTrackSettings, selectedClipId, sourceAudioTrackSettingsByClip]);

	const onSourceAudioTracksMetaChange = useCallback(
		(tracks: SourceAudioTrackMeta) => {
			setSourceAudioTrackMeta((prev) => (isSameTrackMeta(prev, tracks) ? prev : tracks));
			setDefaultSourceAudioTrackSettings((prev) => {
				const next: SourceAudioTrackSettings = {};
				for (const track of tracks) {
					next[track.id] = normalizeSetting(prev[track.id]);
				}
				const prevKeys = Object.keys(prev);
				const nextKeys = Object.keys(next);
				if (prevKeys.length !== nextKeys.length) {
					return next;
				}
				for (const key of nextKeys) {
					const prevSetting = prev[key];
					const nextSetting = next[key];
					if (!prevSetting || !nextSetting) {
						return next;
					}
					if (
						!areSettingsEqual(
							normalizeSetting(prevSetting),
							normalizeSetting(nextSetting),
						)
					) {
						return next;
					}
				}
				return prev;
			});
		},
		[setDefaultSourceAudioTrackSettings],
	);

	const getSourceAudioTrackSettingsForClip = useCallback(
		(clipId: string | null): SourceAudioTrackSettings => {
			if (!clipId) {
				return defaultSourceAudioTrackSettings;
			}
			return {
				...defaultSourceAudioTrackSettings,
				...(sourceAudioTrackSettingsByClip[clipId] ?? {}),
			};
		},
		[defaultSourceAudioTrackSettings, sourceAudioTrackSettingsByClip],
	);

	const onSelectedClipSourceAudioTrackVolumeChange = useCallback(
		(id: string, volume: number) => {
			if (!selectedClipId) return;
			setSourceAudioTrackSettingsByClip((prev) => {
				const prevClip = prev[selectedClipId] ?? defaultSourceAudioTrackSettings;
				const prevSetting = normalizeSetting(prevClip[id]);
				const nextVolume = Number.isFinite(volume)
					? Math.max(0, Math.min(1, volume))
					: prevSetting.volume;
				const nextSetting = { ...prevSetting, volume: nextVolume };
				if (areSettingsEqual(prevSetting, nextSetting)) {
					return prev;
				}
				return {
					...prev,
					[selectedClipId]: {
						...prevClip,
						[id]: nextSetting,
					},
				};
			});
		},
		[defaultSourceAudioTrackSettings, selectedClipId, setSourceAudioTrackSettingsByClip],
	);

	const onSelectedClipSourceAudioTrackNormalizeChange = useCallback(
		(id: string, normalize: boolean) => {
			if (!selectedClipId) return;
			setSourceAudioTrackSettingsByClip((prev) => {
				const prevClip = prev[selectedClipId] ?? defaultSourceAudioTrackSettings;
				const prevSetting = normalizeSetting(prevClip[id]);
				const nextSetting = { ...prevSetting, normalize };
				if (areSettingsEqual(prevSetting, nextSetting)) {
					return prev;
				}
				return {
					...prev,
					[selectedClipId]: {
						...prevClip,
						[id]: nextSetting,
					},
				};
			});
		},
		[defaultSourceAudioTrackSettings, selectedClipId, setSourceAudioTrackSettingsByClip],
	);

	const updateSelectedClipSourceAudioTrackSetting = useCallback(
		(
			id: SourceAudioTrackId,
			updater: (setting: SourceAudioTrackSetting) => SourceAudioTrackSetting,
		) => {
			if (!selectedClipId) return;
			setSourceAudioTrackSettingsByClip((prev) => {
				const prevClip = prev[selectedClipId] ?? defaultSourceAudioTrackSettings;
				const prevSetting = normalizeSetting(prevClip[id]);
				const nextSetting = normalizeSetting(updater(prevSetting));
				if (areSettingsEqual(prevSetting, nextSetting)) {
					return prev;
				}
				return {
					...prev,
					[selectedClipId]: {
						...prevClip,
						[id]: nextSetting,
					},
				};
			});
		},
		[defaultSourceAudioTrackSettings, selectedClipId, setSourceAudioTrackSettingsByClip],
	);

	const onSelectedClipSourceAudioTrackReduceNoiseChange = useCallback(
		(id: string, reduceNoise: boolean) => {
			updateSelectedClipSourceAudioTrackSetting(id, (setting) => ({
				...setting,
				reduceNoise,
			}));
		},
		[updateSelectedClipSourceAudioTrackSetting],
	);

	const onSelectedClipSourceAudioTrackEnhanceVoiceChange = useCallback(
		(id: string, enhanceVoice: boolean) => {
			updateSelectedClipSourceAudioTrackSetting(id, (setting) => ({
				...setting,
				enhanceVoice,
			}));
		},
		[updateSelectedClipSourceAudioTrackSetting],
	);

	const onSelectedClipSourceAudioTrackEnhanceVoiceIntensityChange = useCallback(
		(id: string, intensity: number) => {
			updateSelectedClipSourceAudioTrackSetting(id, (setting) => ({
				...setting,
				enhanceVoiceIntensity: intensity,
			}));
		},
		[updateSelectedClipSourceAudioTrackSetting],
	);

	return {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		onSelectedClipSourceAudioTrackReduceNoiseChange,
		onSelectedClipSourceAudioTrackEnhanceVoiceChange,
		onSelectedClipSourceAudioTrackEnhanceVoiceIntensityChange,
	};
}
