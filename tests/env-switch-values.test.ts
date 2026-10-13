import { afterEach, expect, test, vi } from "vitest";
import { serverKeyDisabled } from "../lib/agent/provider";

afterEach(() => vi.unstubAllEnvs());

test.each([["true", true], ["1", true], ["on", true], ["YES", true], ["false", false], ["off", false], ["", false]])(
  "ALGOSTAGE_DISABLE_SERVER_KEY=%s -> %s", (value, expected) => {
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", value);
    expect(serverKeyDisabled()).toBe(expected);
  });
