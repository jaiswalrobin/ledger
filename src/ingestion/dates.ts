/** Message dates are evidence, not trusted clocks. Allow a small sender-clock skew. */
export function usableEventDate(
  value: string | null | undefined,
  observedAt = new Date(),
): string | null {
  if (!value || value.length > 128 || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))
    return null;
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(observedAt.getTime()) ||
    time < 0 ||
    time > observedAt.getTime() + 5 * 60_000
  )
    return null;
  return new Date(time).toISOString();
}
