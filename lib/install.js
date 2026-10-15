// `spacesheep install`: connect every coding harness on this machine to spacesheep
// at once — sign the machine in (once), point each harness's MCP config at the
// bridge (`spacesheep mcp`, which uses that one key), and put the /sheep skill where
// each harness reads skills. `--ssh host` does the same on other machines from here.
//
// Before this, each harness connected on its own: one sign-in per harness per
// machine. Eleven machines with five harnesses each was about fifty (2026-10-14).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const cfg = require("./config");
const { McpClient } = require("./mcp");
const H = require("./harnesses");
const S = require("./skills");

const machineName = (opts) => String(opts.name || os.hostname().split(".")[0] || "machine").slice(0, 60);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { if (buf.length < 4096) buf += d; });
    process.stdin.on("end", () => resolve(buf));
  });
}

/** Proves a key opens the tools. → number of tools. */
async function checkKey(key) {
  try {
    return (await new McpClient(cfg.origin(), key).listTools()).length;
  } catch (e) {
    if (/\b403\b|insufficient_scope/.test(e.message)) {
      throw Object.assign(new Error("this machine's key can't use the tools (a streams-only or sessions-only key). Sign in with a full key: `spacesheep login`, then run install again"), { code: "EAUTH" });
    }
    throw e;
  }
}

/** This machine's key: the one it holds, or a new one from --key / --code / the browser. */
async function ensureKey(opts, log) {
  const { connectWithKey, redeemCode, deviceLogin, agentClient } = require("./login");
  const save = (fields) => cfg.writeConfig({
    ...cfg.readConfig(), ...fields,
    origin: process.env.SPACESHEEP_ORIGIN || cfg.readConfig().origin || undefined,
    appOrigin: process.env.SPACESHEEP_APP_ORIGIN || cfg.readConfig().appOrigin || undefined,
  });
  const name = machineName(opts);
  if (opts.key === "-") {
    // From another machine's `install --ssh`: a key already minted for this one.
    const key = cfg.cleanKey(await readStdin());
    if (!key.startsWith("ss_")) throw new Error("--key - reads an ss_ key from stdin, and none came");
    await checkKey(key);
    save({ key, machine: name });
    return { key, how: "key from stdin" };
  }
  if (opts.key) {
    const parent = cfg.cleanKey(opts.key);
    if (!parent.startsWith("ss_")) throw new Error("--key takes an ss_ key (create one at https://spacesheep.dev/settings/api-keys#create)");
    const { key, username } = await connectWithKey(cfg.appOrigin(), parent, name, log);
    save({ key, username, machine: name });
    return { key, username, how: `a key of its own, "${name}"` };
  }
  if (opts.code !== undefined) {
    const { key, username, name: saved } = await redeemCode(cfg.appOrigin(), opts.code, name, log, agentClient(process.env));
    save({ key, username, machine: saved });
    return { key, username, how: `a key of its own, "${saved}"` };
  }
  const have = cfg.resolveKey();
  if (have) return { key: have.key, username: cfg.readConfig().username, how: have.source === "env" ? "the key in SPACESHEEP_KEY" : "the key it already had" };
  if (!process.stdin.isTTY) {
    throw Object.assign(new Error("this machine isn't signed in. Run this in a terminal to sign in through the browser, or pass --code ssc_… (spacesheep.dev/start) or --key ss_… (spacesheep.dev/settings/api-keys#create)"), { code: "EAUTH" });
  }
  const { key, username } = await deviceLogin(cfg.origin(), log);
  save({ key, username });
  return { key, username, how: "the browser" };
}

/**
 * The command every harness will run. A global install's own path survives
 * updates; a copy npx unpacked into its cache does not (npx cleans it), and
 * running npx on every harness start costs a registry check and fails offline.
 * So a run from npx copies the CLI (no dependencies, ~300 KB) into the config
 * folder and points the harnesses there.
 */
function stableCommand({ dryRun = false, script = process.argv[1] } = {}) {
  const { stableNode } = require("./memory");
  const p = real(script);
  const viaNpx = /[\\/]_npx[\\/]/.test(p) || /[\\/]\.npm[\\/]/.test(p);
  if (!viaNpx) return { argv: [stableNode(), p, "mcp"], copied: null };
  const root = path.resolve(path.dirname(p), "..");
  const dest = path.join(cfg.configDir(), "cli");
  if (!dryRun) {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const part of ["bin", "lib", "package.json", "LICENSE"]) {
      const from = path.join(root, part);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, part), { recursive: true });
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  return { argv: [stableNode(), path.join(dest, "bin", "spacesheep.js"), "mcp"], copied: dest };
}

/** Which harnesses to touch: --only names them, else every one on this machine. */
function chosen(all, only) {
  if (!only) return all.filter((h) => h.present);
  const want = String(only).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = all.filter((h) => want.some((w) => h.id === w || h.id.startsWith(w + ":") || h.label.toLowerCase() === w));
  const unknown = want.filter((w) => !all.some((h) => h.id === w || h.id.startsWith(w + ":") || h.label.toLowerCase() === w));
  if (unknown.length) throw new Error(`--only: no harness called ${unknown.join(", ")} (known: ${[...new Set(all.map((h) => h.id.split(":")[0]))].join(", ")})`);
  return picked;
}

const pad = (s, n) => (s + " ".repeat(n)).slice(0, Math.max(n, s.length));
const MARKS = { added: "✓", replaced: "✓", updated: "✓", unchanged: "·", removed: "✓", skipped: "!" };

function describe(r) {
  if (r.error) return r.error;
  if (r.note) return r.note;
  if (r.action === "replaced") return `replaced ${r.replaced.map((n) => `"${n}"`).join(", ")} (it signed in on its own)`;
  if (r.action === "updated") return `updated${r.from ? ` from ${r.from}` : ""}`;
  if (r.action === "unchanged") return "already set up";
  return r.action;
}

async function run(opts, log, out) {
  if (opts.ssh) return viaSsh(opts, log);
  const dryRun = !!opts.dryRun;
  const k = await ensureKey(opts, log);
  const tools = await checkKey(k.key);
  const who = k.username || cfg.readConfig().username;
  const machine = cfg.readConfig().machine || machineName(opts);
  const cmd = stableCommand({ dryRun });
  const all = H.harnesses();
  const results = chosen(all, opts.only).map((h) => H.install(h, cmd.argv, { dryRun }));
  let skills = [];
  let skillError = null;
  let skillText = "";
  if (!opts.noSkill) {
    try { skillText = await S.fetchSkill(cfg.appOrigin()); skills = S.installSkills(skillText, S.skillTargets(), { dryRun }); }
    catch (e) { skillError = e.message; }
  }
  const missing = opts.only ? [] : all.filter((h) => !h.present && !/older config/.test(h.label));
  if (opts.json) return out({ machine, username: who || null, tools, command: cmd.argv, copied: cmd.copied, dry_run: dryRun, harnesses: results, skills, skill_error: skillError, not_found: missing.map((h) => h.id) });

  log(`\n  ${dryRun ? "Would connect" : "Connected"} this machine${who ? ` (@${who}` : " ("}${machine ? ` on "${machine}"` : ""}) with ${k.how} — ${tools} tools.`);
  log(`  Every harness below runs: ${cmd.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const w = Math.max(12, ...results.map((r) => r.harness.length));
  for (const r of results) log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, w)}  ${pad(r.file, 34)}  ${describe(r)}`);
  if (!results.length) log("    (no coding harness found on this machine — install one, then run this again)");
  if (missing.length) log(`\n  Not on this machine: ${missing.map((h) => h.label).join(", ")}`);
  if (skillError) log(`\n  ! /sheep skill not installed: ${skillError}`);
  else if (skills.length) {
    log(`\n  /sheep skill ${S.versionOf(skillText) || ""}`.trimEnd());
    for (const s of skills) log(`    ${MARKS[s.action] || "·"} ${pad(s.harness, w)}  ${pad(s.file || "", 34)}  ${describe(s)}`);
  }
  const plugin = H.claudeDirs(os.homedir(), process.env).some((d) => S.hasPlugin(d));
  if (plugin && results.some((r) => r.id.startsWith("claude-code") && r.action !== "skipped")) {
    log(`\n  Claude Code's spacesheep plugin brings its own connection too. If /mcp shows a second`);
    log(`  spacesheep that asks you to sign in, disable that one there; this machine's works for both.`);
  }
  if (cmd.copied) log(`\n  The CLI was copied to ${cmd.copied.replace(os.homedir(), "~")} for the harnesses to run (npx clears its own cache).`);
  log(`\n  ${dryRun ? "Nothing was written (--dry-run)." : "Restart open harnesses (or reconnect: /mcp in Claude Code) to pick it up."}`);
  log(`  Other machines: run \`npx -y spacesheep@latest install\` on each, or from here: \`spacesheep install --ssh host1,host2\`\n`);
}

/** `install --ssh a,b`: mint each machine its own key here, and run install there
 *  with the key on stdin, so it never shows on a screen or in a process list. */
async function viaSsh(opts, log) {
  const { connectWithKey } = require("./login");
  const have = cfg.resolveKey();
  if (!have) throw Object.assign(new Error("sign this machine in first (`spacesheep install` here), then --ssh can give the others keys"), { code: "EAUTH" });
  const hosts = [].concat(opts.ssh).flatMap((h) => String(h).split(",")).map((h) => h.trim()).filter(Boolean);
  for (const h of hosts) if (!/^[A-Za-z0-9._@:-]+$/.test(h)) throw new Error(`--ssh takes host or user@host names (got "${h}")`);
  const spec = opts.package || "spacesheep@latest";
  if (!/^[\w@./:#-]+$/.test(spec)) throw new Error("--package takes an npm spec such as spacesheep@latest or github:spacesheep-dev/spacesheep-cli");
  const extra = [opts.noSkill ? "--no-skill" : "", opts.only ? `--only ${String(opts.only).replace(/[^\w,:-]/g, "")}` : ""].filter(Boolean).join(" ");
  const failed = [];
  for (const host of hosts) {
    const name = host.replace(/^.*@/, "").split(".")[0].slice(0, 60);
    log(`\n  ── ${host} ──`);
    let key;
    try { ({ key } = await connectWithKey(cfg.appOrigin(), have.key, name, () => {})); }
    catch (e) { log(`  ✗ couldn't mint a key for ${host}: ${e.message}`); failed.push(host); continue; }
    // A login shell, so a node from nvm / Homebrew is on PATH.
    const inner = `npx -y ${spec} install --key - --name ${name}${extra ? " " + extra : ""}`;
    const remote = `if command -v bash >/dev/null 2>&1; then exec bash -lc '${inner}'; else exec sh -lc '${inner}'; fi`;
    const code = await new Promise((resolve) => {
      const p = spawn("ssh", [host, remote], { stdio: ["pipe", "inherit", "inherit"] });
      p.on("error", (e) => { log(`  ✗ ssh: ${e.message}`); resolve(1); });
      p.on("close", resolve);
      p.stdin.end(key + "\n");
    });
    if (code !== 0) {
      log(`  ✗ ${host}: install didn't finish (exit ${code}). Its key "${name}" was made; revoke it in Settings → API keys if you won't retry.`);
      failed.push(host);
    }
  }
  log(`\n  ${hosts.length - failed.length} of ${hosts.length} machine(s) connected${failed.length ? ` — failed: ${failed.join(", ")}` : ""}.\n`);
  if (failed.length) process.exitCode = 1;
}

async function status(opts, out, log) {
  const k = cfg.resolveKey();
  const rows = H.harnesses().filter((h) => h.present).map((h) => H.status(h));
  const skills = S.skillTargets().map((t) => {
    if (t.skip) return { harness: t.harness, note: t.skip };
    let text = null;
    try { text = fs.readFileSync(t.file, "utf8"); } catch (_) {}
    return { harness: t.harness, file: t.shown, version: text && text.includes(S.MARK) ? S.versionOf(text) : null };
  });
  if (opts.json) return out({ signed_in: !!k, key_prefix: k ? k.key.slice(0, 8) : null, harnesses: rows, skills });
  log(`\n  This machine: ${k ? `signed in (${k.key.slice(0, 8)}…)` : "not signed in — run `npx -y spacesheep@latest install`"}\n`);
  const w = Math.max(12, ...rows.map((r) => r.harness.length));
  for (const r of rows) {
    const bridge = r.entries.find((e) => e.via === "bridge");
    const remote = r.entries.filter((e) => e.via === "remote");
    const what = r.error ? `! ${r.error}`
      : bridge && !bridge.ok ? `! runs ${bridge.script}, which is gone — run install again`
      : bridge ? `✓ through this machine's key${remote.length ? ` (plus ${remote.length} remote entr${remote.length > 1 ? "ies" : "y"})` : ""}`
      : remote.length ? `· connects on its own (signs in separately) — install switches it`
      : "· not connected";
    log(`    ${pad(r.harness, w)}  ${pad(r.file, 34)}  ${what}`);
  }
  if (skills.length) {
    log(`\n  /sheep skill`);
    for (const s of skills) log(`    ${pad(s.harness, w)}  ${pad(s.file || "", 34)}  ${s.note || (s.version ? s.version : "not installed")}`);
  }
  log("");
}

async function uninstall(opts, log, out) {
  const dryRun = !!opts.dryRun;
  const results = chosen(H.harnesses(), opts.only).map((h) => H.uninstall(h, { dryRun }));
  const skills = opts.noSkill ? [] : S.uninstallSkills(S.skillTargets(), { dryRun });
  if (opts.json) return out({ harnesses: results, skills });
  for (const r of [...results, ...skills]) if (r.action !== "unchanged") log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, 14)}  ${pad(r.file || "", 34)}  ${r.error || r.action}`);
  log(`\n  ${dryRun ? "Would remove" : "Removed"} the bridge from ${results.filter((r) => r.action === "removed").length} harness(es). This machine's key stays (\`spacesheep logout\` forgets it).\n`);
}

module.exports = { run, status, uninstall, stableCommand, chosen, ensureKey };
