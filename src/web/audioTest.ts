/** A guided audio test only counts when the user confirms they spoke and clips arrived. */
export function audioTestSucceeded(
  result: { totalBytes: number; utteranceCount: number } | null,
  spoke: boolean
): boolean {
  return spoke && result != null && result.totalBytes > 0 && result.utteranceCount > 0;
}
