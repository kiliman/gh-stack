import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../cli.ts";
import { ConfigError } from "../config-error.ts";

describe("parseCliArgs", () => {
  test("supports leading global flags before the command", () => {
    const parsed = parseCliArgs(["--yes", "sync", "--dry-run"], {});
    expect(parsed.command).toBe("sync");
    expect(parsed.commandArgs).toEqual(["--dry-run"]);
    expect(parsed.autoYes).toBe(true);
  });

  test("shows global help only when no command is provided", () => {
    expect(parseCliArgs(["--help"], {}).showGlobalHelp).toBe(true);
    expect(parseCliArgs(["log", "--help"], {}).showGlobalHelp).toBe(false);
  });

  test("supports leading version flag", () => {
    const parsed = parseCliArgs(["--version"], {});
    expect(parsed.showVersion).toBe(true);
    expect(parsed.command).toBe("log");
  });

  test("respects GH_STACK_YES from the environment", () => {
    const parsed = parseCliArgs(["status"], { GH_STACK_YES: "1" });
    expect(parsed.autoYes).toBe(true);
  });

  // #96: a leading --help used to be dropped, so the command ran without it.
  test("--help before the command, or help <command>, hands --help to the command", () => {
    for (const argv of [
      ["--help", "submit"],
      ["help", "submit"],
      ["submit", "--help"],
      ["--yes", "--help", "submit", "-n"],
    ]) {
      const parsed = parseCliArgs(argv, {});
      expect(parsed.command).toBe("submit");
      expect(parsed.commandArgs).toContain("--help");
      expect(parsed.showHelp).toBe(true);
      expect(parsed.showGlobalHelp).toBe(false);
    }
    expect(parseCliArgs(["--help", "submit"], {}).commandArgs).toEqual(["--help"]);
    expect(parseCliArgs(["submit", "-n"], {}).showHelp).toBe(false);
  });

  test("help with no command shows the global help", () => {
    expect(parseCliArgs(["help"], {}).showGlobalHelp).toBe(true);
    expect(parseCliArgs(["help"], {}).showHelp).toBe(false);
  });

  test("GH_STACK_YES, GH_STACK_PLAIN and GH_STACK_NO_COLOR take the same booleans as GH_STACK_NO_PUSH", () => {
    for (const on of ["1", "true", "YES"]) {
      const parsed = parseCliArgs(["status"], {
        GH_STACK_YES: on,
        GH_STACK_PLAIN: on,
        GH_STACK_NO_COLOR: on,
      });
      expect([parsed.autoYes, parsed.plain, parsed.noColor]).toEqual([true, true, true]);
    }
    for (const off of ["0", "false", "no", ""]) {
      const parsed = parseCliArgs(["status"], {
        GH_STACK_YES: off,
        GH_STACK_PLAIN: off,
        GH_STACK_NO_COLOR: off,
      });
      expect([parsed.autoYes, parsed.plain, parsed.noColor]).toEqual([false, false, false]);
    }
  });

  test("a non-boolean GH_STACK_YES, GH_STACK_PLAIN or GH_STACK_NO_COLOR is an error", () => {
    for (const name of ["GH_STACK_YES", "GH_STACK_PLAIN", "GH_STACK_NO_COLOR"]) {
      expect(() => parseCliArgs(["status"], { [name]: "sure" })).toThrow(ConfigError);
      expect(() => parseCliArgs(["status"], { [name]: "sure" })).toThrow(`${name}=sure`);
    }
  });

  test("--yes turns on plain output", () => {
    const parsed = parseCliArgs(["--yes", "status"], {});
    expect(parsed.plain).toBe(true);
  });
});
