import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { enhanceSourceAudioPath } from "./audioEnhancementClient";

export function useEnhancedSourceAudioFallbacks(input: {
	sourceAudioFallbackPaths: string[];
	sourceAudioFallbackStartDelayMsByPath: Record<string, number>;
	sourceAudioTrackSettings: SourceAudioTrackSettings;
	isPlaying?: boolean;
}) {
	const [enhancedPathByOriginal, setEnhancedPathByOriginal] = useState<Record<string, string>>(
		{},
	);
	const [previewPathByOriginal, setPreviewPathByOriginal] = useState<Record<string, string>>({});
	const isPlayingRef = useRef(Boolean(input.isPlaying));

	useEffect(() => {
		isPlayingRef.current = Boolean(input.isPlaying);
		if (!input.isPlaying) {
			setPreviewPathByOriginal(enhancedPathByOriginal);
		}
	}, [enhancedPathByOriginal, input.isPlaying]);

	useEffect(() => {
		let cancelled = false;
		setEnhancedPathByOriginal({});
		if (!isPlayingRef.current) {
			setPreviewPathByOriginal({});
		}

		for (const audioPath of input.sourceAudioFallbackPaths) {
			void (async () => {
				const enhancedPath = await enhanceSourceAudioPath(
					audioPath,
					input.sourceAudioFallbackPaths,
					input.sourceAudioTrackSettings,
				);
				if (cancelled || enhancedPath === audioPath) {
					return;
				}
				setEnhancedPathByOriginal((prev) => ({ ...prev, [audioPath]: enhancedPath }));
				if (!isPlayingRef.current) {
					setPreviewPathByOriginal((prev) => ({ ...prev, [audioPath]: enhancedPath }));
				}
			})();
		}

		return () => {
			cancelled = true;
		};
	}, [input.sourceAudioFallbackPaths, input.sourceAudioTrackSettings]);

	return useMemo(() => {
		const pathByOriginal = input.isPlaying ? previewPathByOriginal : enhancedPathByOriginal;
		const paths = input.sourceAudioFallbackPaths.map(
			(audioPath) => pathByOriginal[audioPath] ?? audioPath,
		);
		const startDelayMsByPath: Record<string, number> = {};
		for (const originalPath of input.sourceAudioFallbackPaths) {
			const path = pathByOriginal[originalPath] ?? originalPath;
			const delayMs = input.sourceAudioFallbackStartDelayMsByPath[originalPath];
			if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
				startDelayMsByPath[path] = delayMs;
			}
		}

		return {
			sourceAudioFallbackPaths: paths,
			sourceAudioFallbackStartDelayMsByPath: startDelayMsByPath,
		};
	}, [
		enhancedPathByOriginal,
		input.isPlaying,
		input.sourceAudioFallbackPaths,
		input.sourceAudioFallbackStartDelayMsByPath,
		previewPathByOriginal,
	]);
}
