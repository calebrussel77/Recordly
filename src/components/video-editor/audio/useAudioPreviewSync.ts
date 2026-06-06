import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildResolvedAudioPlan } from "@/lib/exporter/audioRoutingEngine";
import { resolveMediaElementSource } from "@/lib/exporter/localMediaSource";
import {
	clampMediaTimeToDuration,
	enablePitchPreservingPlayback,
	getMediaSyncPlaybackRate,
	resolveCompanionAudioPreviewStartDelaySeconds,
} from "@/lib/mediaTiming";
import type { AudioRegion, SpeedRegion } from "../types";

const SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS = 0.18;
const SOURCE_AUDIO_PREVIEW_PAUSED_SEEK_DRIFT_SECONDS = 0.01;
const SOURCE_AUDIO_PREVIEW_END_TOLERANCE_SECONDS = 0.35;
const SOURCE_AUDIO_PREVIEW_RECOVERY_COOLDOWN_MS = 1200;
const SOURCE_AUDIO_PREVIEW_MIN_ADVANCE_SECONDS = 0.015;
const SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_THRESHOLD_SECONDS = 2.5;
const SOURCE_AUDIO_PREVIEW_SHORT_AUDIO_MARGIN_SECONDS = 0.5;
const SOURCE_AUDIO_PREVIEW_SHORT_REFRESH_INTERVAL_MS = 1500;
const SOURCE_AUDIO_PREVIEW_MAX_SHORT_REFRESH_ATTEMPTS = 6;
const MEDIA_HAVE_CURRENT_DATA = 2;
const MEDIA_NETWORK_NO_SOURCE = 3;

interface SourceAudioPlaybackHealth {
	mediaTime: number;
	observedAtMs: number;
	recoveredAtMs: number;
}

function getNowMs() {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function getSafeMediaTime(audio: HTMLAudioElement) {
	return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
}

function getMediaErrorMessage(audio: HTMLAudioElement) {
	const error = audio.error;
	if (!error) {
		return "unknown media error";
	}
	return `code=${error.code}${error.message ? ` message=${error.message}` : ""}`;
}

// Chromium caches media resources by URL, so calling load() on the same URL
// re-serves the bytes fetched at first load. When a sidecar file is rewritten on
// disk after the element loaded it (recording finalization race), we must change
// the URL to force a fresh fetch. The media server ignores extra query params.
function withMediaCacheBuster(src: string): string {
	try {
		const url = new URL(src);
		url.searchParams.set("__reload", String(Math.round(getNowMs())));
		return url.toString();
	} catch {
		return src;
	}
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
	const isPlayingRef = useRef(isPlaying);
	const lastSourceAudioSyncTimeRef = useRef<number | null>(null);
	const sourceAudioPlaybackHealthRef = useRef<Map<string, SourceAudioPlaybackHealth>>(new Map());
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

	useEffect(() => {
		isPlayingRef.current = isPlaying;
	}, [isPlaying]);

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

			if (Math.abs(audio.playbackRate - 1) > 0.001) {
				audio.playbackRate = 1;
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
			const sourceAudioAtEnd =
				audioDuration !== null && targetTime >= Math.max(0, audioDuration - 0.01);
			const previewAtEnd =
				Number.isFinite(duration) &&
				currentTime >= Math.max(0, duration - SOURCE_AUDIO_PREVIEW_END_TOLERANCE_SECONDS);

			return {
				beforeAudioStart: currentTime + 0.001 < startDelaySeconds,
				atEnd: sourceAudioAtEnd && (!Number.isFinite(duration) || previewAtEnd),
				targetTime,
			};
		},
		[
			currentTime,
			duration,
			getSourceTrackPreviewGain,
			isCurrentClipMuted,
			previewVolume,
			sourceAudioFallbackStartDelayMsByPath,
		],
	);

	const primeSourceAudioPlayback = useCallback(() => {
		for (const [audioPath, audio] of sourceAudioElementsRef.current.entries()) {
			attachHiddenAudioElement(audio);
			const { beforeAudioStart, atEnd, targetTime } = getSourceAudioTimelineState(
				audio,
				audioPath,
			);
			if (!audio.src) {
				continue;
			}
			try {
				audio.currentTime = targetTime;
			} catch {
				// Some media elements reject seeks until metadata is available.
			}
			if (!beforeAudioStart && !atEnd) {
				void playSourceAudioElement(audio, audioPath);
			}
		}
	}, [getSourceAudioTimelineState, playSourceAudioElement]);

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
				sourceAudioPlaybackHealthRef.current.delete(id);
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
					if (audioElement.readyState >= MEDIA_HAVE_CURRENT_DATA) {
						setSourceAudioPlayable(audioPath, true);
					}
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

			const loadedResource = sourceAudioElementResourcesRef.current.get(audioPath);
			if (loadedResource !== audioPath && audio.dataset.loadingResource !== audioPath) {
				// Mark the load as in-flight so concurrent effect re-runs neither start
				// a duplicate load nor treat the resource as resolved while src is still
				// empty. The resource is recorded as loaded ONLY after src is actually
				// assigned, so a superseded/aborted load can never leave the element
				// stuck on an empty src (which previously muted re-opened recordings).
				audio.dataset.loadingResource = audioPath;
				audio.pause();
				audio.src = "";
				setSourceAudioPlayable(audioPath, false);
				sourceAudioElementRevokersRef.current.get(audioPath)?.();
				sourceAudioElementRevokersRef.current.delete(audioPath);
				sourceAudioElementResourcesRef.current.delete(audioPath);
				sourceAudioPlaybackHealthRef.current.set(audioPath, {
					mediaTime: getSafeMediaTime(audio),
					observedAtMs: getNowMs(),
					recoveredAtMs: 0,
				});
				setSourceAudioReadyRevision((revision) => revision + 1);

				void (async () => {
					try {
						const resolved = await resolveMediaElementSource(audioPath);
						const latestAudio = existing.get(audioPath);

						if (latestAudio !== audio) {
							// Element was replaced (path changed) or removed (unmount).
							resolved.revoke();
							if (audio.dataset.loadingResource === audioPath) {
								delete audio.dataset.loadingResource;
							}
							return;
						}

						sourceAudioElementRevokersRef.current.set(audioPath, resolved.revoke);
						const shouldResume =
							isPlayingRef.current || (!latestAudio.paused && !latestAudio.ended);
						const restoreTime = getSafeMediaTime(latestAudio);
						latestAudio.pause();
						latestAudio.src = resolved.src;
						latestAudio.load();
						sourceAudioElementResourcesRef.current.set(audioPath, audioPath);
						delete latestAudio.dataset.loadingResource;
						if (restoreTime > 0) {
							try {
								latestAudio.currentTime = restoreTime;
							} catch {
								// Some media elements reject seeks until metadata is available.
							}
						}
						setSourceAudioReadyRevision((revision) => revision + 1);
						if (shouldResume) {
							void playSourceAudioElement(latestAudio, audioPath);
						}
					} catch (error) {
						if (audio.dataset.loadingResource === audioPath) {
							delete audio.dataset.loadingResource;
						}
						sourceAudioElementRevokersRef.current.get(audioPath)?.();
						sourceAudioElementRevokersRef.current.delete(audioPath);
						sourceAudioElementResourcesRef.current.delete(audioPath);
						sourceAudioPlaybackHealthRef.current.delete(audioPath);
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

		if (resolvedSourceTracks.length === 0) {
			lastSourceAudioSyncTimeRef.current = null;
		}
	}, [
		getSourceTrackPreviewGain,
		isCurrentClipMuted,
		onSourceFallbackLoadError,
		playSourceAudioElement,
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
			sourceAudioPlaybackHealthRef.current.clear();
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

		for (const audio of sourceAudioElementsRef.current.values()) {
			const sourceAudioPath = audio.dataset.sourceAudioPath ?? "";
			const { beforeAudioStart, atEnd, targetTime } = getSourceAudioTimelineState(
				audio,
				sourceAudioPath,
			);
			if (!audio.src) {
				continue;
			}
			const nowMs = getNowMs();
			let health = sourceAudioPlaybackHealthRef.current.get(sourceAudioPath);
			if (!health) {
				health = {
					mediaTime: getSafeMediaTime(audio),
					observedAtMs: nowMs,
					recoveredAtMs: 0,
				};
				sourceAudioPlaybackHealthRef.current.set(sourceAudioPath, health);
			}

			const shouldSeek =
				audio.ended ||
				timelineJumped ||
				(!isPlaying && Math.abs(audio.currentTime - targetTime) > driftThreshold) ||
				(isPlaying &&
					Math.abs(audio.currentTime - targetTime) >
						SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_THRESHOLD_SECONDS);
			if (shouldSeek) {
				try {
					audio.currentTime = targetTime;
				} catch {
					// no-op
				}
			}

			const shouldPlaySourceAudio =
				isPlaying && !beforeAudioStart && !atEnd && audio.volume > 0;
			const audioMediaTime = getSafeMediaTime(audio);
			const audioDriftSeconds = Math.abs(audioMediaTime - targetTime);
			const audioAdvanced =
				audioMediaTime > health.mediaTime + SOURCE_AUDIO_PREVIEW_MIN_ADVANCE_SECONDS ||
				audioDriftSeconds <= SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS;

			if (audioAdvanced || !shouldPlaySourceAudio) {
				health.mediaTime = audioMediaTime;
				health.observedAtMs = nowMs;
			}

			const audioDurationValue = Number.isFinite(audio.duration) ? audio.duration : null;
			const reachedAudioEnd =
				audioDurationValue !== null &&
				targetTime >=
					Math.max(0, audioDurationValue - SOURCE_AUDIO_PREVIEW_END_TOLERANCE_SECONDS);
			// The timeline still has content past this audio track's end. This happens when
			// the sidecar file was finalized (grown) by recording post-processing AFTER the
			// <audio> element cached its metadata (a finalization race), or when the mic track
			// is genuinely shorter than the video. We must not spin the recovery/reload loop
			// forever in this state.
			const timelineOutlastsAudio =
				audioDurationValue !== null &&
				Number.isFinite(duration) &&
				duration > audioDurationValue + SOURCE_AUDIO_PREVIEW_SHORT_AUDIO_MARGIN_SECONDS;

			if (shouldPlaySourceAudio && reachedAudioEnd && timelineOutlastsAudio) {
				// Reload ONCE per observed duration to refresh possibly-stale metadata. If the
				// duration is unchanged afterwards, the track is simply shorter than the
				// timeline: leave it ended instead of looping audio.load()/play() forever.
				const reloadKey = String(audioDurationValue);
				if (audio.dataset.shortAudioReloadKey !== reloadKey) {
					audio.dataset.shortAudioReloadKey = reloadKey;
					health.recoveredAtMs = nowMs;
					health.mediaTime = targetTime;
					health.observedAtMs = nowMs;
					try {
						// Force a fresh fetch: a plain load() re-serves the cached
						// (short) version captured before the sidecar was finalized.
						audio.src = withMediaCacheBuster(audio.src);
						audio.load();
						audio.currentTime = targetTime;
						void playSourceAudioElement(audio, sourceAudioPath);
					} catch {
						// Seeks can be rejected while the element reloads.
					}
				}
			} else if (shouldPlaySourceAudio) {
				const shouldRecover =
					audio.paused ||
					audio.ended ||
					audio.readyState < MEDIA_HAVE_CURRENT_DATA ||
					audio.networkState === MEDIA_NETWORK_NO_SOURCE ||
					audioDriftSeconds > SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_THRESHOLD_SECONDS;
				const canRecover =
					nowMs - health.recoveredAtMs > SOURCE_AUDIO_PREVIEW_RECOVERY_COOLDOWN_MS;
				if (shouldRecover && canRecover) {
					health.recoveredAtMs = nowMs;
					health.mediaTime = targetTime;
					health.observedAtMs = nowMs;
					console.warn("[source-audio-preview] recovering playback", {
						sourceAudioPath,
						targetTime,
						currentTime: audio.currentTime,
						readyState: audio.readyState,
						networkState: audio.networkState,
						paused: audio.paused,
						ended: audio.ended,
					});
					try {
						if (
							audio.networkState === MEDIA_NETWORK_NO_SOURCE ||
							audio.readyState < MEDIA_HAVE_CURRENT_DATA
						) {
							audio.load();
						}
						audio.currentTime = targetTime;
					} catch {
						// Some media elements reject seeks while reloading.
					}
				}
				void playSourceAudioElement(audio, sourceAudioPath);
			} else if ((!isPlaying || beforeAudioStart || audio.volume <= 0) && !audio.paused) {
				audio.pause();
			}
		}

		lastSourceAudioSyncTimeRef.current = currentTime;
	}, [
		currentTime,
		duration,
		isPlaying,
		resolvedSourceTracks,
		sourceAudioReadyRevision,
		getSourceAudioTimelineState,
		playSourceAudioElement,
	]);

	// A recording sidecar can still be finalizing (and thus shorter on disk) when the
	// editor first loads it, so the <audio> element caches a too-short duration. While
	// playback is PAUSED, refresh such elements from disk (cache-busted) a few times so
	// the finalized, full-length file is in place before the user presses play — this
	// avoids a mid-playback reload glitch when reaching the stale end. Bounded so a mic
	// track that is genuinely shorter than the video stops retrying.
	useEffect(() => {
		if (resolvedSourceTracks.length === 0 || !Number.isFinite(duration) || duration <= 0) {
			return;
		}

		const refreshShortSidecars = () => {
			if (isPlayingRef.current) {
				return;
			}
			for (const audio of sourceAudioElementsRef.current.values()) {
				const audioDuration = Number.isFinite(audio.duration) ? audio.duration : null;
				if (audioDuration === null || !audio.src) {
					continue;
				}
				if (duration <= audioDuration + SOURCE_AUDIO_PREVIEW_SHORT_AUDIO_MARGIN_SECONDS) {
					continue;
				}
				const attempts = Number(audio.dataset.shortRefreshAttempts ?? "0");
				if (
					!Number.isFinite(attempts) ||
					attempts >= SOURCE_AUDIO_PREVIEW_MAX_SHORT_REFRESH_ATTEMPTS
				) {
					continue;
				}
				audio.dataset.shortRefreshAttempts = String(attempts + 1);
				const restoreTime = getSafeMediaTime(audio);
				audio.src = withMediaCacheBuster(audio.src);
				audio.load();
				if (restoreTime > 0) {
					try {
						audio.currentTime = restoreTime;
					} catch {
						// Seeks can be rejected while the element reloads.
					}
				}
			}
		};

		refreshShortSidecars();
		const intervalId = window.setInterval(
			refreshShortSidecars,
			SOURCE_AUDIO_PREVIEW_SHORT_REFRESH_INTERVAL_MS,
		);
		return () => window.clearInterval(intervalId);
	}, [duration, resolvedSourceTracks]);

	useEffect(() => {
		if (!isPlaying || resolvedSourceTracks.length === 0) {
			return;
		}
		for (const [audioPath, audio] of sourceAudioElementsRef.current.entries()) {
			if (audio.paused && audio.src) {
				void playSourceAudioElement(audio, audioPath);
			}
		}
	}, [isPlaying, playSourceAudioElement, resolvedSourceTracks.length]);

	return {
		hasPlayableSourceAudio,
		primeSourceAudioPlayback,
	};
}
