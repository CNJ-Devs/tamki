// Product default, not a media standard. Compare in displayed timeline seconds.
export const SEEK_BOUNDARY_EPSILON_SECONDS = 0.02;
export type SeekBoundary = { atStart: boolean; atEnd: boolean };

export function seekBoundary(
  position: number,
  duration: number,
  ended = false,
): SeekBoundary {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0)
    return { atStart: true, atEnd: true };
  const epsilon = Math.min(SEEK_BOUNDARY_EPSILON_SECONDS, duration / 4);
  // Allow the floating-point error of the subtraction itself at the threshold.
  const rounding = Number.EPSILON * Math.max(1, duration) * 4;
  return {
    atStart: position <= epsilon + rounding,
    atEnd: ended || duration - position <= epsilon + rounding,
  };
}

export function mediaSeekBoundary(
  media: Pick<
    HTMLMediaElement,
    "duration" | "currentTime" | "ended" | "readyState" | "error"
  > | null,
  duration: number,
): SeekBoundary {
  if (
    !media ||
    media.readyState < 1 ||
    media.error ||
    !Number.isFinite(media.duration) ||
    media.duration <= 0
  )
    return { atStart: true, atEnd: true };
  // A retimed preview clip may already report ended at its final physical sample.
  // That must not turn a few physical milliseconds into seconds on the work timeline.
  return seekBoundary(
    (media.currentTime / media.duration) * duration,
    duration,
    media.ended && duration === media.duration,
  );
}
