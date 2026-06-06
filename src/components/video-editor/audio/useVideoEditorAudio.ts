import React, { useMemo } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type { AudioRegion, ClipRegion, SpeedRegion } from "../types";
import { getActiveClipIdAtSourceTime, isClipMutedById } from "./clipAudio";
import { useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useEnhancedSourceAudioFallbacks } from "./useEnhancedSourceAudioFallbacks";
import { useSourceAudioFallback } from "./useSourceAudioFallback";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	sourceAudioRefreshKey?: number;
	sessionSourceAudioFallbackPaths?: string[];
	sessionSourceAudioFallbackStartDelayMsByPath?: Record<string, number>;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	effectiveSpeedRegions: SpeedRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	currentTime: number;
	timelineTime: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
}

export function useVideoEditorAudio({
	currentSourcePath,
	sourceAudioRefreshKey = 0,
	sessionSourceAudioFallbackPaths = [],
	sessionSourceAudioFallbackStartDelayMsByPath = {},
	selectedClipId,
	clipRegions,
	audioRegions,
	effectiveSpeedRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	currentTime,
	timelineTime,
	duration,
	isPlaying,
	previewVolume,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioFallbackLoading,
	} = useSourceAudioFallback({
		currentSourcePath: fallbackLookupSourcePath,
		refreshKey: sourceAudioRefreshKey,
		sessionFallbackPaths: sessionSourceAudioFallbackPaths,
		sessionFallbackStartDelayMsByPath: sessionSourceAudioFallbackStartDelayMsByPath,
		summarizeErrorMessage,
	});

	const activeClipIdAtCurrentTime = useMemo(
		() => getActiveClipIdAtSourceTime(currentTime, clipRegions),
		[clipRegions, currentTime],
	);
	const isCurrentClipMuted = useMemo(
		() => isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);

	const {
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
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const {
		sourceAudioFallbackPaths: enhancedSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath: enhancedSourceAudioFallbackStartDelayMsByPath,
	} = useEnhancedSourceAudioFallbacks({
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioTrackSettings: activeSourceAudioTrackSettings,
		isPlaying,
	});

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, enhancedSourceAudioFallbackPaths),
		[currentSourcePath, enhancedSourceAudioFallbackPaths],
	);
	const previewSourceAudioFallbackPaths = sourceTrackRoutingPolicy.playbackPaths;
	const shouldMutePreviewVideo = sourceTrackRoutingPolicy.muteEmbeddedPreview;

	const { hasPlayableSourceAudio, primeSourceAudioPlayback } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		currentTime,
		timelineTime,
		duration,
		effectiveSpeedRegions,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath: enhancedSourceAudioFallbackStartDelayMsByPath,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});

	return {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo: shouldMutePreviewVideo && hasPlayableSourceAudio,
		sourceAudioFallbackLoading,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
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
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
		primeSourceAudioPlayback,
	};
}
