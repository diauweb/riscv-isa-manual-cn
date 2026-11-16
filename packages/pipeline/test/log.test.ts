import { afterEach, describe, expect, test } from "bun:test";
import { getVerbosity, isVerbose, parseVerbosity, setVerbosity, vlog } from "../src/log.ts";

describe("parseVerbosity", () => {
  test("parses booleans, strings, numbers, and clamps 0..3", () => {
    expect(parseVerbosity(undefined)).toBe(0);
    expect(parseVerbosity("")).toBe(0);
    expect(parseVerbosity(false)).toBe(0);
    expect(parseVerbosity("no")).toBe(0);
    expect(parseVerbosity(true)).toBe(1);
    expect(parseVerbosity("true")).toBe(1);
    expect(parseVerbosity("1")).toBe(1);
    expect(parseVerbosity("2")).toBe(2);
    expect(parseVerbosity("3")).toBe(3);
    expect(parseVerbosity("9")).toBe(3);
    expect(parseVerbosity(-1)).toBe(0);
    expect(parseVerbosity("invalid")).toBe(0);
  });
});

describe("vlog and verbosity levels", () => {
  afterEach(() => {
    setVerbosity(null);
  });

  test("gates messages by verbosity level", () => {
    const messages: string[] = [];
    const capture = (msg: string) => messages.push(msg);

    setVerbosity(0);
    expect(getVerbosity()).toBe(0);
    expect(isVerbose(1)).toBe(false);
    vlog(1, "step", capture);
    vlog(2, "doc", capture);
    vlog(3, "block", capture);
    expect(messages).toEqual([]);

    setVerbosity(1);
    expect(isVerbose(1)).toBe(true);
    expect(isVerbose(2)).toBe(false);
    vlog(1, "step", capture);
    vlog(2, "doc", capture);
    vlog(3, "block", capture);
    expect(messages).toEqual(["step"]);

    messages.length = 0;
    setVerbosity(2);
    vlog(1, "step", capture);
    vlog(2, "doc", capture);
    vlog(3, "block", capture);
    expect(messages).toEqual(["step", "doc"]);

    messages.length = 0;
    setVerbosity(3);
    vlog(1, "step", capture);
    vlog(2, "doc", capture);
    vlog(3, "block", capture);
    expect(messages).toEqual(["step", "doc", "block"]);
  });
});
