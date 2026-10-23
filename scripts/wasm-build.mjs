#!/usr/bin/env node
/**
 * Builds crates/neuroflow-wasm into src/wasm with no host paths in the binary.
 *
 * Panic messages embed the source path of every dependency and standard library
 * file they come from, so a plain build differs between machines and home
 * directories. This remaps Cargo's home to /cargo and a local rust-src copy to
 * the /rustc/<commit> prefix official toolchains already use, then fails if the
 * binary still names the home directory. Cargo's `trim-paths` would do the same
 * but is unstable. The same rustc, wasm-bindgen and wasm-opt still give the same
 * bytes on any host; the wasm-pack profile strips the `producers` section, which
 * records how the wasm-bindgen CLI itself was built.
 *
 * Usage: npm run wasm:build [-- extra wasm-pack build args]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rustc = (...args) => execFileSync("rustc", args, { encoding: "utf8" }).trim();
const commit = rustc("-vV").match(/^commit-hash: (\w+)$/m)?.[1];
if (!commit) throw new Error("rustc -vV reported no commit-hash");

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const remaps = [
  [cargoHome, "/cargo"],
  [join(rustc("--print", "sysroot"), "lib", "rustlib", "src", "rust"), `/rustc/${commit}`],
  [root.replace(/\/$/, ""), "/neuroflow"],
];
const rustflags = [process.env.RUSTFLAGS, ...remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)]
  .filter(Boolean).join(" ");

execFileSync("wasm-pack", ["build", "crates/neuroflow-wasm", "--target", "web", "--out-dir", "../../src/wasm", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: rustflags },
});

const wasm = readFileSync(join(root, "src", "wasm", "neuroflow_wasm_bg.wasm")).toString("latin1");
const leaked = [homedir(), cargoHome, root].filter((path) => wasm.includes(path));
if (leaked.length) throw new Error(`src/wasm/neuroflow_wasm_bg.wasm still embeds ${leaked.join(", ")}`);
