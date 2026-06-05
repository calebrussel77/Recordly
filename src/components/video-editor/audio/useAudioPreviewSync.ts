import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildResolvedAudioPlan } from "@/lib/exporter/audioRoutingEngine";
import {
	getNormalizedMediaResourceUrl,
	resolveMediaElementSource,
} from "@/lib/exporter/localMediaSource";
import {
	clampMediaTimeToDuration,
	enablePitchPreservingPlayback,
	getMediaSyncPlaybackRate,
	resolveCompanionAudioPreviewStartDelaySeconds,
} from "@/lib/mediaTiming";
import type { AudioRegion, SpeedRegion } from "../types";

const SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS = 0.18;
const SOURCE_AUDIO_PREVIEW_PAUSED_SEEK_DRIFT_SECONDS = 0.01;

function getMediaErrorMessage(audio: HTMLAudioElement) {
	const error = audio.error;
	if (!error) {
		return "unknown media error";
	}
	return `code=${error.code}${error.message ? ` message=${error.message}` : ""}`;
}

function attachHiddenAudioElement(audio: HTMLAudioElement) {
	if (typeof document === "undefined" || audio.isConnected) {
		return;
	}
	audio.style.display = "none";
	audio.setAttribute("aria-hidden", "true");
	document.body.appendChild(audio);
}

function detachAudioElement(audio: HTMLAudioElement) {
	if (audio.isConnected) {
		audio.remove();
	}
}

function primeMediaElementSource(audio: HTMLAudioElement, resource: string) {
	const optimisticSrc = getNormalizedMediaResourceUrl(resource);
	if (!optimisticSrc || audio.src === optimisticSrc) {
		return;
	}

	audio.src = optimisticSrc;
	audio.load();
}

interface UseAudioPreviewSyncParams {
	audioRegions: AudioRegion[];
	previewVolume: number;
	isPlaying: boolean;
	currentTime: number;
	timelineTime: number;
	duration: number;
	effectiveSpeedRegions: SpeedRegion[];
	previewSourceAudioFallbackPaths: string[];
	sourceAudioFallbackStartDelayMsByPath: Record<string, number>;
	isCurrentClipMuted: boolean;
	getSourceTrackPreviewGain: (audioPath: string) => number;
	onSourceFallbackLoadError: (error: unknown) => void;
}

interface UseAudioPreviewSyncResult {
	hasPlayableSourceAudio: boolean;
	primeSourceAudioPlayback: () => void;
}

export function useAudioPreviewSync({
	audioRegions,
	previewVolume,
	isPlaying,
	currentTime,
	timelineTime,
	duration,
	effectiveSpeedRegions,
	previewSourceAudioFallbackPaths,
	sourceAudioFallbackStartDelayMsByPath,
	isCurrentClipMuted,
	getSourceTrackPreviewGain,
	onSourceFallbackLoadError,
}: UseAudioPreviewSyncParams): UseAudioPreviewSyncResult {
	const resolvedPlan = useMemo(
		() =>
			buildResolvedAudioPlan({
				videoResource: null,
				sourceAudioFallbackPaths: previewSourceAudioFallbackPaths,
				audioRegions,
			}),
		[audioRegions, previewSourceAudioFallbackPaths],
	);
	const resolvedUserTracks = useMemo(
		() => resolvedPlan.tracks.filter((track) => track.kind === "user"),
		[resolvedPlan],
	);
	const resolvedSourceTracks = useMemo(
		() => resolvedPlan.tracks.filter((track) => track.kind !== "user"),
		[resolvedPlan],
	);

	const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
	const audioElementRevokersRef = useRef<Map<string, () => void>>(new Map());
	const audioElementResourcesRef = useRef<Map<string, string>>(new Map());
	const sourceAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
	const sourceAudioElementReadyCleanupsRef = useRef<Map<string, () => void>>(new Map());
	const sourceAudioMediaNodesRef = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());
	const sourceAudioGainNodesRef = useRef<Map<string, GainNode>>(new Map());
	const sourceAudioElementRevokersRef = useRef<Map<string, () => void>>(new Map());
	const sourceAudioElementResourcesRef = useRef<Map<string, string>>(new Map());
	const sourceAudioContextRef = useRef<AudioContext | null>(null);
	const sourceAudioMasterGainRef = useRef<GainNode | null>(null);
	const sourceAudioResumePromiseRef = useRef<Promise<void> | null>(null);
	const lastSourceAudioSyncTimeRef = useRef<number | null>(null);
	const [sourceAudioReadyRevision, setSourceAudioReadyRevision] = useState(0);
	const [playableSourceAudioPaths, setPlayableSourceAudioPaths] = useState<Set<string>>(
		() => new Set(),
	);
	const hasPlayableSourceAudio = useMemo(
		() =>
			resolvedSourceTracks.length > 0 &&
			resolvedSourceTracks.every((track) =>
				playableSourceAudioPaths.has(track.sourceRef.path),
			),
		[playableSourceAudioPaths, resolvedSourceTracks],
	);

	const setSourceAudioPlayable = useCallback((audioPath: string, playable: boolean) => {
		setPlayableSourceAudioPaths((prev) => {
			const hasPath = prev.has(audioPath);
			if (hasPath === playable) {
				return prev;
			}
			const next = new Set(prev);
			if (playable) {
				next.add(audioPath);
			} else {
				next.delete(audioPath);
			}
			return next;
		});
	}, []);

	const playSourceAudioElement = useCallback(
		(audio: HTMLAudioElement, audioPath: string) =>
			audio
				.play()
				.then(() => {
					setSourceAudioPlayable(audioPath, true);
				})
				.catch((error) => {
					setSourceAudioPlayable(audioPath, false);
					console.warn("[source-audio-preview] play failed", {
						audioPath,
						error,
						readyState: audio.readyState,
						networkState: audio.networkState,
						mediaError: getMediaErrorMessage(audio),
					});
				}),
		[setSourceAudioPlayable],
	);

	const ensureSourceAudioContext = useCallback(() => {
		if (!sourceAudioContextRef.current) {
			const context = new AudioContext({ latencyHint: "interactive" });
			const masterGain = context.createGain();
			masterGain.gain.value = 1;
			masterGain.connect(context.destination);
			sourceAudioContextRef.current = context;
			sourceAudioMasterGainRef.current = masterGain;
		}
		return sourceAudioContextRef.current;
	}, []);

	const ensureSourceAudioRunning = useCallback(() => {
		const context = ensureSourceAudioContext();
		if (context.state === "running") {
			return Promise.resolve();
		}
		if (!sourceAudioResumePromiseRef.current) {
			sourceAudioResumePromiseRef.current = context
				.resume()
				.catch(() => undefined)
				.finally(() => {
					sourceAudioResumePromiseRef.current = null;
				});
		}
		return sourceAudioResumePromiseRef.current;
	}, [ensureSourceAudioContext]);

	const getSourceAudioTimelineState = useCallback(
		(audio: HTMLAudioElement, sourceAudioPath: string) => {
			audio.volume = Math.max(
				0,
				Math.min(
					1,
					getSourceTrackPreviewGain(sourceAudioPath) *
						(isCurrentClipMuted ? 0 : previewVolume),
				),
			);
			enablePitchPreservingPlayback(audio);

			const activeSpeedRegion = effectiveSpeedRegions.find(
				(region) =>
					currentTime * 1000 >= region.startMs && currentTime * 1000 < region.endMs,
			);
			const targetPlaybackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
			if (Math.abs(audio.playbackRate - targetPlaybackRate) > 0.001) {
				audio.playbackRate = targetPlaybackRate;
			}

			const audioDuration = Number.isFinite(audio.duration) ? audio.duration : null;
			const recordedStartDelayMs = sourceAudioFallbackStartDelayMsByPath[sourceAudioPath];
			const startDelaySeconds = resolveCompanionAudioPreviewStartDelaySeconds({
				timelineDuration: duration,
				audioDuration,
				recordedStartDelayMs,
			});
			const targetTime = clampMediaTimeToDuration(
				currentTime - startDelaySeconds,
				audioDuration,
			);

			return {
				beforeAudioStart: currentTime + 0.001 < startDelaySeconds,
				atEnd: audioDuration !== null && targetTime >= audioDuration,
				targetTime,
			};
		},
		[
			currentTime,
			duration,
			effectiveSpeedRegions,
			getSourceTrackPreviewGain,
			isCurrentClipMuted,
			previewVolume,
			sourceAudioFallbackStartDelayMsByPath,
		],
	);

	const primeSourceAudioPlayback = useCallback(() => {
		void ensureSourceAudioRunning();
		for (const [audioPath, audio] of sourceAudioElementsRef.current.entries()) {
			attachHiddenAudioElement(audio);
			const { beforeAudioStart, atEnd, targetTime } = getSourceAudioTimelineState(
				audio,
				audioPath,
			);
			try {
				audio.currentTime = targetTime;
			} catch {
				// Some media elements reject seeks until metadata is available.
			}
			if (!beforeAudioStart && !atEnd) {
				void playSourceAudioElement(audio, audioPath);
			}
		}
	}, [ensureSourceAudioRunning, getSourceAudioTimelineState, playSourceAudioElement]);

	useEffect(() => {
		if (typeof window === "undefined" || resolvedSourceTracks.length === 0) {
			return;
		}

		const retrySourceAudioPlayback = () => {
			if (isPlaying) {
				primeSourceAudioPlayback();
			}
		};

		window.addEventListener("pointerdown", retrySourceAudioPlayback, true);
		window.addEventListener("keydown", retrySourceAudioPlayback, true);
		return () => {
			window.removeEventListener("pointerdown", retrySourceAudioPlayback, true);
			window.removeEventListener("keydown", retrySourceAudioPlayback, true);
		};
	}, [isPlaying, primeSourceAudioPlayback, resolvedSourceTracks.length]);

	useEffect(() => {
		let cancelled = false;
		const existing = audioElementsRef.current;
		const currentIds = new Set(resolvedUserTracks.map((track) => track.id));

		for (const [id, audio] of existing) {
			if (!currentIds.has(id)) {
				audio.pause();
				audio.src = "";
				audioElementRevokersRef.current.get(id)?.();
				audioElementRevokersRef.current.delete(id);
				audioElementResourcesRef.current.delete(id);
				existing.delete(id);
			}
		}

		for (const track of resolvedUserTracks) {
			let audio = existing.get(track.id);
			if (!audio) {
				audio = new Audio();
				audio.preload = "auto";
				existing.set(track.id, audio);
			}

			if (audioElementResourcesRef.current.get(track.id) !== track.sourceRef.path) {
				audio.pause();
				audio.src = "";
				audioElementRevokersRef.current.get(track.id)?.();
				audioElementRevokersRef.current.delete(track.id);
				audioElementResourcesRef.current.set(track.id, track.sourceRef.path);

				void (async () => {
					const resolved = await resolveMediaElementSource(track.sourceRef.path);
					const latestAudio = existing.get(track.id);

					if (
						cancelled ||
						latestAudio !== audio ||
						audioElementResourcesRef.current.get(track.id) !== track.sourceRef.path
					) {
						resolved.revoke();
						return;
					}

					audioElementRevokersRef.current.set(track.id, resolved.revoke);
					latestAudio.src = resolved.src;
				})();
			}

			audio.volume = Math.max(0, Math.min(1, track.gain * previewVolume));
		}

		return () => {
			cancelled = true;
		};
	}, [previewVolume, resolvedUserTracks]);

	useEffect(() => {
		let cancelled = false;
		const existing = sourceAudioElementsRef.current;
		const currentIds = new Set(resolvedSourceTracks.map((track) => track.sourceRef.path));

		for (const [id, audio] of existing) {
			if (!currentIds.has(id)) {
				audio.pause();
				audio.src = "";
				detachAudioElement(audio);
				setSourceAudioPlayable(id, false);
				sourceAudioElementReadyCleanupsRef.current.get(id)?.();
				sourceAudioElementReadyCleanupsRef.current.delete(id);
				sourceAudioMediaNodesRef.current.get(id)?.disconnect();
				sourceAudioMediaNodesRef.current.delete(id);
				sourceAudioGainNodesRef.current.get(id)?.disconnect();
				sourceAudioGainNodesRef.current.delete(id);
				sourceAudioElementRevokersRef.current.get(id)?.();
				sourceAudioElementRevokersRef.current.delete(id);
				sourceAudioElementResourcesRef.current.delete(id);
				existing.delete(id);
			}
		}

		for (const track of resolvedSourceTracks) {
			const audioPath = track.sourceRef.path;
			let audio = existing.get(audioPath);
			if (!audio) {
				audio = new Audio();
				audio.preload = "auto";
				audio.muted = false;
				attachHiddenAudioElement(audio);
				const audioElement = audio;
				const notifyReady = () => {
					setSourceAudioReadyRevision((revision) => revision + 1);
				};
				const notifyError = () => {
					setSourceAudioPlayable(audioPath, false);
					console.warn("[source-audio-preview] media load failed", {
						audioPath,
						readyState: audioElement.readyState,
						networkState: audioElement.networkState,
						mediaError: getMediaErrorMessage(audioElement),
					});
				};
				audio.addEventListener("loadedmetadata", notifyReady);
				audio.addEventListener("canplay", notifyReady);
				audio.addEventListener("canplaythrough", notifyReady);
				audioElement.addEventListener("error", notifyError);
				sourceAudioElementReadyCleanupsRef.current.set(audioPath, () => {
					audioElement.removeEventListener("loadedmetadata", notifyReady);
					audioElement.removeEventListener("canplay", notifyReady);
					audioElement.removeEventListener("canplaythrough", notifyReady);
					audioElement.removeEventListener("error", notifyError);
				});
				existing.set(audioPath, audio);
			}
			attachHiddenAudioElement(audio);
			audio.volume = 1;
			audio.dataset.sourceAudioPath = audioPath;

			// Web Audio API createMediaElementSource breaks preservesPitch on Chromium.
			// We route directly through the HTMLAudioElement to ensure pitch preservation works
			// during speed changes. Note: this limits maximum preview volume to 1.0 (100%).

			if (sourceAudioElementResourcesRef.current.get(audioPath) !== audioPath) {
				audio.pause();
				audio.src = "";
				setSourceAudioPlayable(audioPath, false);
				sourceAudioElementRevokersRef.current.get(audioPath)?.();
				sourceAudioElementRevokersRef.current.delete(audioPath);
				sourceAudioElementResourcesRef.current.set(audioPath, audioPath);
				primeMediaElementSource(audio, audioPath);
				setSourceAudioReadyRevision((revision) => revision + 1);

				void (async () => {
					try {
						const resolved = await resolveMediaElementSource(audioPath);
						const latestAudio = existing.get(audioPath);

						if (
							cancelled ||
							latestAudio !== audio ||
							sourceAudioElementResourcesRef.current.get(audioPath) !== audioPath
						) {
							resolved.revoke();
							return;
						}

						sourceAudioElementRevokersRef.current.set(audioPath, resolved.revoke);
						if (latestAudio.src === resolved.src) {
							return;
						}
						if (!latestAudio.paused && !latestAudio.ended && latestAudio.src) {
							return;
						}
						latestAudio.src = resolved.src;
						latestAudio.load();
						setSourceAudioReadyRevision((revision) => revision + 1);
					} catch (error) {
						if (cancelled) {
							return;
						}

						sourceAudioElementRevokersRef.current.get(audioPath)?.();
						sourceAudioElementRevokersRef.current.delete(audioPath);
						sourceAudioElementResourcesRef.current.delete(audioPath);
						setSourceAudioPlayable(audioPath, false);
						const latestAudio = existing.get(audioPath);
						if (latestAudio === audio) {
							latestAudio.pause();
							latestAudio.src = "";
						}
						onSourceFallbackLoadError(error);
					}
				})();
			}

			audio.volume = Math.max(
				0,
				Math.min(
					1,
					getSourceTrackPreviewGain(audioPath) * (isCurrentClipMuted ? 0 : previewVolume),
				),
			);
		}

		if (sourceAudioMasterGainRef.current) {
			sourceAudioMasterGainRef.current.gain.value = isCurrentClipMuted
				? 0
				: Math.max(0, Math.min(1, previewVolume));
		}

		if (resolvedSourceTracks.length === 0) {
			lastSourceAudioSyncTimeRef.current = null;
		}

		return () => {
			cancelled = true;
		};
	}, [
		getSourceTrackPreviewGain,
		isCurrentClipMuted,
		onSourceFallbackLoadError,
		resolvedSourceTracks,
		previewVolume,
		setSourceAudioPlayable,
	]);

	useEffect(() => {
		return () => {
			for (const audio of audioElementsRef.current.values()) {
				audio.pause();
				audio.src = "";
			}
			for (const revoke of audioElementRevokersRef.current.values()) {
				revoke();
			}
			audioElementsRef.current.clear();
			audioElementRevokersRef.current.clear();
			audioElementResourcesRef.current.clear();
			for (const audio of sourceAudioElementsRef.current.values()) {
				audio.pause();
				audio.src = "";
				detachAudioElement(audio);
			}
			for (const cleanup of sourceAudioElementReadyCleanupsRef.current.values()) {
				cleanup();
			}
			for (const node of sourceAudioMediaNodesRef.current.values()) {
				node.disconnect();
			}
			for (const node of sourceAudioGainNodesRef.current.values()) {
				node.disconnect();
			}
			for (const revoke of sourceAudioElementRevokersRef.current.values()) {
				revoke();
			}
			sourceAudioElementsRef.current.clear();
			sourceAudioElementReadyCleanupsRef.current.clear();
			sourceAudioMediaNodesRef.current.clear();
			sourceAudioGainNodesRef.current.clear();
			sourceAudioElementRevokersRef.current.clear();
			sourceAudioElementResourcesRef.current.clear();
			if (sourceAudioMasterGainRef.current) {
				sourceAudioMasterGainRef.current.disconnect();
				sourceAudioMasterGainRef.current = null;
			}
			const context = sourceAudioContextRef.current;
			sourceAudioContextRef.current = null;
			sourceAudioResumePromiseRef.current = null;
			if (context) {
				void context.close();
			}
			lastSourceAudioSyncTimeRef.current = null;
		};
	}, []);

	useEffect(() => {
		const currentTimeMs = timelineTime * 1000;
		const activeSpeedRegion = effectiveSpeedRegions.find(
			(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
		);
		const targetPlaybackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;

		for (const track of resolvedUserTracks) {
			const audio = audioElementsRef.current.get(track.id);
			if (!audio) continue;

			const startMs = track.timelineBinding.startMs;
			const endMs = track.timelineBinding.endMs;
			const isInRegion = currentTimeMs >= startMs && currentTimeMs < endMs;

			if (isPlaying && isInRegion) {
				enablePitchPreservingPlayback(audio);
				const audioOffset = (currentTimeMs - startMs) / 1000;
				if (Math.abs(audio.currentTime - audioOffset) > 0.2) {
					audio.currentTime = audioOffset;
				}
				const syncedPlaybackRate = getMediaSyncPlaybackRate({
					basePlaybackRate: targetPlaybackRate,
					currentTime: audio.currentTime,
					targetTime: audioOffset,
				});
				if (Math.abs(audio.playbackRate - syncedPlaybackRate) > 0.001) {
					audio.playbackRate = syncedPlaybackRate;
				}
				if (audio.paused) {
					audio.play().catch(() => undefined);
				}
			} else if (!audio.paused) {
				audio.pause();
			}
		}
	}, [effectiveSpeedRegions, isPlaying, resolvedUserTracks, timelineTime]);

	useEffect(() => {
		void sourceAudioReadyRevision;
		if (resolvedSourceTracks.length === 0) {
			lastSourceAudioSyncTimeRef.current = null;
			return;
		}

		const previousTimelineTime = lastSourceAudioSyncTimeRef.current;
		const timelineJumped =
			previousTimelineTime === null || Math.abs(currentTime - previousTimelineTime) > 0.25;
		const driftThreshold = isPlaying
			? SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS
			: SOURCE_AUDIO_PREVIEW_PAUSED_SEEK_DRIFT_SECONDS;
		if (sourceAudioMasterGainRef.current) {
			sourceAudioMasterGainRef.current.gain.value = isCurrentClipMuted
				? 0
				: Math.max(0, Math.min(1, previewVolume));
		}

		for (const audio of sourceAudioElementsRef.current.values()) {
			const sourceAudioPath = audio.dataset.sourceAudioPath ?? "";
			const { beforeAudioStart, atEnd, targetTime } = getSourceAudioTimelineState(
				audio,
				sourceAudioPath,
			);

			const shouldSeek =
				timelineJumped ||
				(!isPlaying && Math.abs(audio.currentTime - targetTime) > driftThreshold) ||
				(isPlaying && Math.abs(audio.currentTime - targetTime) > 0.9);
			if (shouldSeek) {
				try {
					audio.currentTime = targetTime;
				} catch {
					// no-op
				}
			}

			if (isPlaying && !beforeAudioStart && !atEnd) {
				void ensureSourceAudioRunning().then(() => {
					void playSourceAudioElement(audio, sourceAudioPath);
				});
			} else if (!audio.paused) {
				audio.pause();
			}
		}

		lastSourceAudioSyncTimeRef.current = currentTime;
	}, [
		currentTime,
		isCurrentClipMuted,
		isPlaying,
		previewVolume,
		resolvedSourceTracks,
		sourceAudioReadyRevision,
		ensureSourceAudioRunning,
		getSourceAudioTimelineState,
		playSourceAudioElement,
	]);

	useEffect(() => {
		if (!isPlaying || resolvedSourceTracks.length === 0) {
			return;
		}
		void ensureSourceAudioRunning().then(() => {
			for (const [audioPath, audio] of sourceAudioElementsRef.current.entries()) {
				if (audio.paused) {
					void playSourceAudioElement(audio, audioPath);
				}
			}
		});
	}, [ensureSourceAudioRunning, isPlaying, playSourceAudioElement, resolvedSourceTracks.length]);

	return { hasPlayableSourceAudio, primeSourceAudioPlayback };
}
