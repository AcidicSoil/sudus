import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/hookenv.mjs";

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json", ".muse-plugin/plugin.json"];
const SKILLS = ["install-sudus", "new-project", "existing-project", "next-feature", "report-sudus-issue"];

test("every manifest carries package.json's version exactly once", () => {
  const v = read("package.json").version;
  for (const m of MANIFESTS) {
    const text = readFileSync(join(ROOT, m), "utf8");
    assert.equal((text.match(/"version"\s*:\s*"[^"]+"/g) ?? []).length, 1, m);
    assert.ok(new RegExp(`"version"\\s*:\\s*"${v}"`).test(text), `${m} lacks ${v}`);
  }
});
test("Claude Code registers session-start, turn and stop", () => {
  const h = read("hooks/hooks.json").hooks;
  assert.ok(h.SessionStart[0].hooks[0].command.endsWith('/hooks/session-start.sh"'));
  assert.ok(h.UserPromptSubmit[0].hooks[0].command.endsWith('/hooks/turn.sh"'));
  assert.ok(h.Stop[0].hooks[0].command.endsWith('/hooks/stop.sh"'));
});
test("Claude Code reads the status line module through plugin.json, never through hooks/hooks.json", () => {
  // Codex reads hooks/hooks.json too, so it keeps the shell hooks alone; the module and its settings
  // are Claude Code's.
  assert.deepEqual(Object.keys(read("hooks/hooks.json")), ["hooks"]);
  const p = read(".claude-plugin/plugin.json");
  assert.equal(p.hooks, "./mod/hooks.json");
  assert.deepEqual(read("mod/hooks.json").modules, ["./register.tsx"]);
  assert.ok(existsSync(join(ROOT, "mod/register.tsx")));
  assert.deepEqual(Object.keys(p.userConfig), ["view", "face", "motion", "command"]);
  assert.equal(p.userConfig.view.default, "off");
  // The plugin directory's validator refuses an option key it does not know, such as options,
  // which Claude Code accepts; register.tsx reads any view it does not know as off.
  for (const [k, o] of Object.entries(p.userConfig)) {
    assert.deepEqual(Object.keys(o).filter((x) => !["type", "title", "description", "default", "required", "sensitive"].includes(x)), [], k);
    assert.ok(["string", "number", "boolean", "directory", "file"].includes(o.type) && o.title && o.description, k);
  }
  for (const m of [".codex-plugin/plugin.json", ".muse-plugin/plugin.json"]) assert.ok(!readFileSync(join(ROOT, m), "utf8").includes("mod/"), m);
});
test("the plugin icon is a square SVG of at least 128px at the directory's path", () => {
  const svg = readFileSync(join(ROOT, ".claude-plugin/icon.svg"), "utf8");
  const [w, h] = [/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1], /<svg[^>]*\sheight="(\d+)"/.exec(svg)?.[1]].map(Number);
  assert.ok(w === h && w >= 128, `${w}x${h}`);
  assert.match(svg, /viewBox="0 0 (\d+) \1"/);
  assert.ok(!/[^\x00-\x7F]/.test(svg));
});
test("Muse registers the hooks it supports and lists the five skills", () => {
  const m = read(".muse-plugin/plugin.json");
  assert.deepEqual(m.capabilities.hooks.map((x) => x.event).sort(), ["SessionStart", "Stop"]);
  for (const x of m.capabilities.hooks) assert.equal(x.command[0], "sh");
  assert.deepEqual(m.capabilities.skills.map((s) => s.id), SKILLS);
});
test("Codex lists the skills directory and the five skills exist", () => {
  assert.equal(read(".codex-plugin/plugin.json").skills, "./skills/");
  for (const s of SKILLS) assert.ok(existsSync(join(ROOT, "skills", s, "SKILL.md")), s);
});
test("no manifest, hook file or skill names next-iteration", () => {
  for (const p of [...MANIFESTS, "hooks/hooks.json", "mod/hooks.json", ...SKILLS.map((s) => `skills/${s}/SKILL.md`)]) {
    if (existsSync(join(ROOT, p))) assert.ok(!readFileSync(join(ROOT, p), "utf8").includes("next-iteration"), p);
  }
});
test("docs/plans is not shipped", () => {
  const files = read("package.json").files;
  assert.ok(Array.isArray(files) && !files.some((f) => f.startsWith("docs/plans")));
  for (const f of ["bin/", "lib/", "hooks/", "mod/", "skills/"]) assert.ok(files.includes(f), f);
});
