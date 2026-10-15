export interface BuildCommitCheckResult {
  ok: boolean;
  message: string;
}

export function checkBuildCommit(
  built: string | null | undefined,
  head: string | null | undefined,
): BuildCommitCheckResult {
  const normalizedBuilt = built?.trim() || "";
  const normalizedHead = head?.trim() || "";

  if (normalizedBuilt && normalizedHead && normalizedBuilt === normalizedHead) {
    return {
      ok: true,
      message: `build commit matches HEAD: ${normalizedHead}`,
    };
  }

  const builtDisplay = normalizedBuilt || "<missing>";
  const headDisplay = normalizedHead || "<missing>";

  return {
    ok: false,
    message: `rebuild needed: .next/BUILD_COMMIT=${builtDisplay} HEAD=${headDisplay}; run npm run build`,
  };
}
