export const HOOK_BYPASS_REASON =
  "Blocked: this command skips or disables the pre-commit hook. The hook runs `pnpm verify`, the floor every commit must pass. Drop the bypass (`--no-verify`, `git commit -n`, `LEFTHOOK=0`, `core.hooksPath`, `lefthook uninstall`, edits under `.git/hooks`), read the hook output, and fix the failure.";

export type Verdict =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string };

interface Word {
  readonly text: string;
  readonly quoted: boolean;
  readonly redirect: boolean;
}

const SEGMENT_BREAKS = new Set([";", "&", "|", "(", ")", "`", "\n"]);
const SHELLS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const WRAPPERS = new Set([
  "builtin",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
  "xargs",
]);
const HOOK_READERS = new Set([
  "cat",
  "diff",
  "file",
  "grep",
  "head",
  "less",
  "ls",
  "rg",
  "stat",
  "tail",
  "tree",
  "wc",
]);
const GIT_GLOBALS_WITH_VALUE = new Set([
  "-C",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);
const COMMIT_SHORT_WITH_VALUE = new Set(["C", "F", "c", "m", "t"]);
const COMMIT_LONG_WITH_VALUE = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--fixup",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
  "--trailer",
]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const NO_VERIFY = "--no-verify";
const NO_VERIFY_SHORTEST_PREFIX = "--no-v".length;

const segmentsOf = (command: string): Word[][] => {
  const segments: Word[][] = [[]];
  let text = "";
  let started = false;
  let quoted = false;
  let quote: "'" | '"' | undefined;

  const finish = (): void => {
    if (started) {
      segments.at(-1)?.push({ text, quoted, redirect: false });
    }
    text = "";
    started = false;
    quoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        text += command.charAt(index);
      } else {
        text += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      index += 1;
      text += command.charAt(index);
      started = true;
    } else if (char === ">") {
      finish();
      segments.at(-1)?.push({ text: ">", quoted: false, redirect: true });
    } else if (SEGMENT_BREAKS.has(char)) {
      finish();
      segments.push([]);
    } else if (/\s/u.test(char)) {
      finish();
    } else {
      text += char;
      started = true;
    }
  }
  finish();
  return segments.filter((segment) => segment.length > 0);
};

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

const isAssignment = (word: Word): boolean => !word.quoted && ASSIGNMENT.test(word.text);

const disablesHooks = (word: Word): boolean => {
  if (!isAssignment(word)) {
    return false;
  }
  const separator = word.text.indexOf("=");
  const name = word.text.slice(0, separator);
  const value = word.text
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  return (
    (name === "LEFTHOOK" && (value === "0" || value === "false")) ||
    (name === "LEFTHOOK_EXCLUDE" && value !== "") ||
    name === "GIT_CONFIG_PARAMETERS" ||
    (name.startsWith("GIT_CONFIG_KEY_") && value === "core.hookspath")
  );
};

const commandWords = (segment: readonly Word[]): string[] => {
  const words = segment.filter((word) => !word.redirect);
  const start = words.findIndex(
    (word) => !isAssignment(word) && !WRAPPERS.has(basename(word.text)),
  );
  return start === -1 ? [] : words.slice(start).map((word) => word.text);
};

const isNoVerify = (arg: string): boolean =>
  arg.length >= NO_VERIFY_SHORTEST_PREFIX && NO_VERIFY.startsWith(arg);

const namesHooksPath = (setting: string): boolean =>
  setting.split("=")[0]?.trim().toLowerCase() === "core.hookspath";

const commitSkipsHooks = (args: readonly string[]): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      return false;
    }
    if (isNoVerify(arg)) {
      return true;
    }
    if (COMMIT_LONG_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (/^-[^-]/u.test(arg)) {
      for (let flag = 1; flag < arg.length; flag += 1) {
        const char = arg.charAt(flag);
        if (char === "n") {
          return true;
        }
        if (COMMIT_SHORT_WITH_VALUE.has(char)) {
          if (flag === arg.length - 1) {
            index += 1;
          }
          break;
        }
      }
    }
  }
  return false;
};

const configSetsHooksPath = (args: readonly string[]): boolean =>
  args.some(namesHooksPath) && !args.some((arg) => CONFIG_READS.has(arg));

const gitSkipsHooks = (args: readonly string[]): boolean => {
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    if (option === "-c") {
      if (namesHooksPath(args[index + 1] ?? "")) {
        return true;
      }
      index += 2;
    } else if (option.startsWith("-c") || option.startsWith("--config-env=")) {
      if (namesHooksPath(option.replace(/^(?:-c|--config-env=)/u, ""))) {
        return true;
      }
      index += 1;
    } else {
      index += GIT_GLOBALS_WITH_VALUE.has(option) ? 2 : 1;
    }
  }
  const [subcommand, ...rest] = args.slice(index);
  if (subcommand === "commit") {
    return commitSkipsHooks(rest);
  }
  if (subcommand === "config") {
    return configSetsHooksPath(rest);
  }
  return rest.some(isNoVerify);
};

const touchesHooksDirectory = (segment: readonly Word[]): boolean => {
  const program = basename(commandWords(segment)[0] ?? "");
  return segment.some(
    (word, index) =>
      word.text.includes(".git/hooks") &&
      (segment[index - 1]?.redirect === true || !HOOK_READERS.has(program)),
  );
};

const segmentSkipsHooks = (segment: readonly Word[]): boolean => {
  if (segment.some(disablesHooks) || touchesHooksDirectory(segment)) {
    return true;
  }
  const [program = "", ...args] = commandWords(segment);
  const name = basename(program);
  if (name === "git") {
    return gitSkipsHooks(args);
  }
  if (name === "export") {
    return segment.slice(1).some(disablesHooks);
  }
  if (name === "lefthook" || args.includes("lefthook")) {
    return args.includes("uninstall");
  }
  if (SHELLS.has(name)) {
    const script = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg));
    return script !== -1 && skipsHooks(args[script + 1] ?? "");
  }
  if (name === "eval") {
    return skipsHooks(args.join(" "));
  }
  return false;
};

export const skipsHooks = (command: string): boolean => segmentsOf(command).some(segmentSkipsHooks);

export const checkCommand = (command: string): Verdict =>
  skipsHooks(command) ? { action: "block", reason: HOOK_BYPASS_REASON } : { action: "allow" };
