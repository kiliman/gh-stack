import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../cli.ts";

describe("parseCliArgs", () => {
  test("supports leading global flags before the command", () => {
    const parsed = parseCliArgs(["--yes", "sync", "--dry-run"], {});
    expect(parsed.command).toBe("sync");
    expect(parsed.commandArgs).toEqual(["--dry-run"]);
    expect(parsed.autoYes).toBe(true);
  });

  test("shows global help only when no command is provided", () => {
    expect(parseCliArgs(["--help"], {}).showGlobalHelp).toBe(true);
    expect(parseCliArgs(["show", "--help"], {}).showGlobalHelp).toBe(false);
  });

  test("supports leading version flag", () => {
    const parsed = parseCliArgs(["--version"], {});
    expect(parsed.showVersion).toBe(true);
    expect(parsed.command).toBe("show");
  });

  test("respects GH_STACK_YES from the environment", () => {
    const parsed = parseCliArgs(["status"], { GH_STACK_YES: "1" });
    expect(parsed.autoYes).toBe(true);
  });
});
