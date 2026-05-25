import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SOURCE_AUDIO_FALLBACK_TOAST_ID } from "@/components/video-editor/audio/audioTypes";

const SOURCE_AUDIO_FALLBACK_RETRY_INTERVAL_MS = 500;
const SOURCE_AUDIO_FALLBACK_MAX_EMPTY_RETRIES = 12;
const SOURCE_AUDIO_FALLBACK_MAX_RECORDING_EMPTY_RETRIES = 240;

interface UseSourceAudioFallbackParams {
	currentSourcePath: string | null;
	refreshKey?: number;
	summarizeErrorMessage: (message: string) => string;
}

function wait(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLikelyRecordlyRecording(sourcePath: string) {
	return /(?:^|[\\/])recording-\d+/i.test(sourcePath);
}

export function useSourceAudioFallback({
	currentSourcePath,
	refreshKey = 0,
	summarizeErrorMessage,
}: UseSourceAudioFallbackParams) {
	const [sourceAudioFallbackPaths, setSourceAudioFallbackPaths] = useState<string[]>([]);
	const [sourceAudioFallbackStartDelayMsByPath, setSourceAudioFallbackStartDelayMsByPath] =
		useState<Record<string, number>>({});

	useEffect(() => {
		let cancelled = false;
		setSourceAudioFallbackPaths([]);
		setSourceAudioFallbackStartDelayMsByPath({});

		if (!currentSourcePath) {
			return () => {
				cancelled = true;
			};
		}

		void (async () => {
			const maxEmptyRetries = isLikelyRecordlyRecording(currentSourcePath)
				? SOURCE_AUDIO_FALLBACK_MAX_RECORDING_EMPTY_RETRIES
				: SOURCE_AUDIO_FALLBACK_MAX_EMPTY_RETRIES;

			for (let attempt = 0; attempt <= maxEmptyRetries; attempt += 1) {
				try {
					const result =
						await window.electronAPI.getVideoAudioFallbackPaths(currentSourcePath);
					if (cancelled) {
						return;
					}
					if (!result.success) {
						setSourceAudioFallbackPaths([]);
						setSourceAudioFallbackStartDelayMsByPath({});
						toast.warning(
							result.error
								? `Could not load companion audio sources: ${summarizeErrorMessage(result.error)}`
								: "Could not load companion audio sources. Playback and export may miss microphone audio.",
							{ id: SOURCE_AUDIO_FALLBACK_TOAST_ID, duration: 10000 },
						);
						return;
					}

					const paths = result.paths ?? [];
					if (paths.length === 0 && attempt < maxEmptyRetries) {
						await wait(SOURCE_AUDIO_FALLBACK_RETRY_INTERVAL_MS);
						if (cancelled) {
							return;
						}
						continue;
					}

					toast.dismiss(SOURCE_AUDIO_FALLBACK_TOAST_ID);
					setSourceAudioFallbackPaths(paths);
					setSourceAudioFallbackStartDelayMsByPath(result.startDelayMsByPath ?? {});
					return;
				} catch (error) {
					if (!cancelled) {
						setSourceAudioFallbackPaths([]);
						setSourceAudioFallbackStartDelayMsByPath({});
						toast.warning(
							`Could not load companion audio sources: ${summarizeErrorMessage(String(error))}`,
							{ id: SOURCE_AUDIO_FALLBACK_TOAST_ID, duration: 10000 },
						);
					}
					return;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [currentSourcePath, refreshKey, summarizeErrorMessage]);

	return { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath };
}
