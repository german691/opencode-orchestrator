#!/usr/bin/env node
"use strict";

/*
 * opencode-orchestrator MCP server
 *
 * Exposes ONE tool to Claude Code:
 *   - opencode_coding: delegate a coding task to opencode, which runs the
 *     coding model opencode-go/deepseek-v4.1-flash.
 *
 * Claude is the orchestrator and reviewer; opencode is the only executor.
 * Dependency-free: implements the MCP stdio JSON-RPC protocol directly.
 * IMPORTANT: stdout is reserved for protocol frames. All diagnostics go to stderr.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const SERVER_NAME = "opencode-orchestrator";
const SERVER_VERSION = "2.1.0";
const DEFAULT_PROTOCOL = "2024-11-05";

const CONFIG = {
  opencodeBin: process.env.OPENCODE_BIN || "",
  opencodeModel: process.env.OPENCODE_MODEL || "opencode-go/deepseek-v4.1-flash",
  opencodeAgent: process.env.OPENCODE_AGENT || "",
  opencodeAuto: !/^(0|false|no)$/i.test(process.env.OPENCODE_AUTO || "1"),
  opencodeDefaultMode: process.env.OPENCODE_DEFAULT_MODE || "safe",
  opencodeTimeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS || 900000),
};

// Tope de salida devuelta al cliente: una corrida verbosa no debe inundar el contexto.
const MAX_OUTPUT_CHARS = Number(process.env.OPENCODE_MAX_OUTPUT_CHARS || 30000);
function tail(text, max = MAX_OUTPUT_CHARS) {
  const t = String(text || "").trim();
  return t.length > max ? `[... ${t.length - max} chars truncated ...]\n${t.slice(-max)}` : t;
}

// Archivos que la corrida dejó modificados/nuevos (git status corto). Best-effort.
function changedFiles(cwd) {
  try {
    const out = require("node:child_process").execFileSync("git", ["status", "--short"], {
      cwd, encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "(sin cambios)";
  } catch {
    return "(no es un repo git o git no disponible)";
  }
}

const AUDIT_LOG = path.join(__dirname, "audit.log");

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(" ")}\n`);
}

// Best-effort audit trail for opencode_coding calls. Never throws: a failed
// audit write must not break the tool call.
function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  } catch (err) {
    log("audit write failed:", err && err.message ? err.message : String(err));
  }
}

// Progress notification (only sent when the caller supplied a progressToken).
function notifyProgress(progressToken, progress, message) {
  send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, message },
  });
}

// Serialize opencode runs: only one opencode_coding executes at a time; later
// calls wait their turn and report how long they queued. The chain swallows
// outcomes so one failed run never blocks the queue.
let opencodeChain = Promise.resolve();
function withOpencodeLock(fn) {
  const result = opencodeChain.then(() => fn());
  opencodeChain = result.then(() => {}, () => {});
  return result;
}

/*
 * Coding modes. Each mode maps to an opencode agent and whether opencode's
 * non-interactive run auto-approves permissions.
 *   readonly - no edits, only safe read/test commands (agent denies the rest)
 *   safe     - edits allowed, destructive/privileged shell denied (default)
 *   auto     - unrestricted default agent, everything auto-approved (opt-in)
 */
const MODES = {
  readonly: { agent: "coder-readonly", auto: true },
  safe: { agent: "coder", auto: true },
  auto: { agent: "", auto: true },
};

/* ------------------------------------------------------------------ */
/* opencode invocation                                                 */
/* ------------------------------------------------------------------ */

function resolveOpencode() {
  if (CONFIG.opencodeBin && fs.existsSync(CONFIG.opencodeBin)) {
    return { cmd: CONFIG.opencodeBin, shell: false };
  }
  const candidates = [];
  if (process.env.APPDATA) {
    // Paquete actual (@opencode/cli): sin esto cae a shell:true y cmd.exe
    // interpreta ">" como redirección, corta saltos de línea y rompe tildes.
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: c, shell: false };
  }
  return { cmd: "opencode", shell: process.platform === "win32" };
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        shell: options.shell,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err && err.message ? err.message : err), timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Kill the whole process tree: on Windows child.kill() leaves grandchildren alive.
    const killTree = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill();
        }
      } catch { /* ignore */ }
    };
    if (options.signal) {
      const onAbort = () => {
        killTree();
        finish({ code: null, stdout, stderr, timedOut: false, cancelled: true });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Resolve now with the partial output we have: a child that ignores kill()
      // (or a grandchild holding the pipes open) must not hang the tool call.
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs || CONFIG.opencodeTimeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${err.message}` , timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function startJob(args) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("`prompt` is required");

  // Default working directory. Claude Code sets CLAUDE_PROJECT_DIR for stdio
  // MCP servers (project root), so coding tasks land in the right repo both in
  // the CLI and in the Desktop app's Code tab. Fall back to the process cwd.
  const defaultCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : defaultCwd;
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!args.cwd && !process.env.CLAUDE_PROJECT_DIR) {
    throw new Error(`no cwd given and CLAUDE_PROJECT_DIR is unset (would run in ${cwd}); pass \`cwd\` explicitly`);
  }

  const { cmd, shell } = resolveOpencode();
  const cliArgs = ["run"];

  // Coding model is fixed to DeepSeek 4.1 flash. Claude decides how much effort
  // to spend by how it writes the task; there is no effort knob here.
  const model = CONFIG.opencodeModel;
  if (model) cliArgs.push("--model", model);

  const mode = String(args.mode || CONFIG.opencodeDefaultMode || "safe").toLowerCase();
  const preset = MODES[mode] || MODES.safe;

  const agent = args.agent !== undefined ? String(args.agent) : (preset.agent || CONFIG.opencodeAgent);
  if (agent) cliArgs.push("--agent", agent);

  if (Array.isArray(args.files)) {
    for (const f of args.files) cliArgs.push("-f", String(f));
  }

  const auto = args.auto !== undefined ? Boolean(args.auto) : preset.auto;
  if (auto) cliArgs.push("--auto");

  cliArgs.push(prompt);

  const effectiveMode = MODES[mode] ? mode : `${mode}->safe`;
  const timeoutMs = args.timeout_ms ? Number(args.timeout_ms) : CONFIG.opencodeTimeoutMs;

  // Only one opencode at a time: queue here and measure how long we waited.
  const queuedAt = Date.now();
  const ctl = new AbortController();
  const job = { id: crypto.randomUUID().slice(0, 8), ctl, startedAt: queuedAt, preview: prompt.slice(0, 80), cwd, result: null };
  job.done = withOpencodeLock(async () => {
    const queuedMs = Date.now() - queuedAt;
    job.startedRunAt = Date.now();
    // Cancelado mientras esperaba su turno: no se lanza el proceso.
    if (ctl.signal.aborted) {
      return { text: `cancelled before starting (queued_ms=${queuedMs})`, isError: true };
    }

    const startedAt = Date.now();
    const result = await runProcess(cmd, cliArgs, { cwd, shell, timeoutMs, signal: ctl.signal });
    const durationMs = Date.now() - startedAt;

    log(`opencode done exit=${result.code}${result.timedOut ? " (timed out)" : ""} duration_ms=${durationMs} queued_ms=${queuedMs}`);

    audit({
      ts: new Date().toISOString(),
      mode: effectiveMode,
      cwd,
      agent: agent || null,
      model: model || null,
      duration_ms: durationMs,
      exit: result.code,
      timedOut: Boolean(result.timedOut),
      cancelled: Boolean(result.cancelled),
      queued_ms: queuedMs,
      prompt_preview: prompt.slice(0, 120),
      stdout_tail: result.code !== 0 ? result.stdout.slice(-600) : undefined,
      stderr_tail: result.code !== 0 ? result.stderr.slice(-600) : undefined,
    });

    const header = [
      `opencode ${cmd === "opencode" ? "(PATH)" : cmd}`,
      `model=${model || "(default)"}`,
      `mode=${effectiveMode}`,
      agent ? `agent=${agent}` : "agent=(default)",
      `auto=${auto}`,
      `cwd=${cwd}`,
      `queued_ms=${queuedMs}`,
      `duration_ms=${durationMs}`,
      `exit=${result.code}${result.timedOut ? " (timed out)" : ""}`,
    ].filter(Boolean).join(" | ");

    const body = [
      header,
      "",
      "--- stdout ---",
      tail(result.stdout) || "(empty)",
      "",
      "--- stderr ---",
      tail(result.stderr, 8000) || "(empty)",
      "",
      "--- git status --short (cwd) ---",
      changedFiles(cwd),
    ].join("\n");

    // A timeout is always an error, even if the killed process exited 0.
    return { text: body, isError: result.code !== 0 || Boolean(result.timedOut) || Boolean(result.cancelled) };
  }).then((r) => { job.result = r; return r; });
  jobs.set(job.id, job);
  return job;
}

/*
 * Claude Desktop cancels any MCP request after ~60s (ignores MCP_TOOL_TIMEOUT
 * and progress notifications). So a tool call never blocks longer than WAIT_MS:
 * if the job is still running we return its id and the caller polls with
 * opencode_wait. Jobs live independently of the request that started them.
 */
const WAIT_MS = Number(process.env.OPENCODE_WAIT_MS || 45000);
const jobs = new Map(); // id -> job

async function waitForJob(job) {
  let timer;
  const pending = new Promise((resolve) => { timer = setTimeout(() => resolve(null), WAIT_MS); });
  const r = await Promise.race([job.done, pending]);
  clearTimeout(timer);
  if (r) {
    jobs.delete(job.id);
    return { text: `job_id=${job.id} (finished)\n${r.text}`, isError: r.isError };
  }
  const secs = Math.round((Date.now() - job.startedAt) / 1000);
  return {
    text: `STILL RUNNING | job_id=${job.id} | elapsed=${secs}s | task="${job.preview}"\n` +
      `Not an error: opencode keeps working in the background. Call opencode_wait with this job_id ` +
      `to wait for the result (repeat until finished), or opencode_cancel to stop it.`,
    isError: false,
  };
}

// Estado de la cola: qué corre, qué espera y hace cuánto (sin bloquear).
function listJobs() {
  if (!jobs.size) return { text: "no active jobs", isError: false };
  const now = Date.now();
  const lines = [...jobs.values()].map((j) => {
    const estado = j.result ? "finished (uncollected)" : j.startedRunAt ? "running" : "queued";
    const secs = Math.round((now - j.startedAt) / 1000);
    return `job_id=${j.id} | ${estado} | age=${secs}s | cwd=${j.cwd} | task="${j.preview}"`;
  });
  return { text: lines.join("\n"), isError: false };
}

function getJob(args) {
  const id = String(args.job_id || "");
  const job = jobs.get(id);
  if (!job) throw new Error(`unknown job_id "${id}" (already delivered, cancelled, or server restarted). Active: ${[...jobs.keys()].join(", ") || "none"}`);
  return job;
}

/* ------------------------------------------------------------------ */
/* MCP tool registry                                                   */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "opencode_coding",
    description:
      "Delegate an implementation/coding task to opencode, which runs DeepSeek 4.1 flash " +
      "(opencode-go/deepseek-v4.1-flash). Use this whenever actual code should be written, " +
      "edited, or run in a repository; Claude plans, reviews and verifies, opencode executes. " +
      "Choose `mode` by risk: 'readonly' to inspect only, 'safe' (default) to edit code while " +
      "blocking destructive/privileged shell, and 'auto' only when the user explicitly wants " +
      "unrestricted autonomy. Returns stdout/stderr and exit status. Blocks at most ~45s: if the task " +
      "is longer it answers 'STILL RUNNING' with a job_id; then call opencode_wait(job_id) repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full coding task / instructions for opencode. Claude decides the effort by how the task is written." },
        cwd: { type: "string", description: "Working directory (repository) to run opencode in. Defaults to the project directory." },
        mode: {
          type: "string",
          enum: ["readonly", "safe", "auto"],
          description: "Permission mode. readonly = no edits, read/test only; safe = edit code but deny destructive/privileged shell (default); auto = unrestricted default agent, fully auto-approved (opt-in).",
        },
        agent: { type: "string", description: "Override the opencode agent name (otherwise chosen by `mode`)." },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to the task (optional)." },
        auto: { type: "boolean", description: "Force auto-approval on/off, overriding the mode's default." },
        timeout_ms: { type: "number", description: "Override timeout in milliseconds (default OPENCODE_TIMEOUT_MS, 900000)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "opencode_wait",
    description:
      "Wait (up to ~45s) for a running opencode job started by opencode_coding. Use it when " +
      "opencode_coding answered 'STILL RUNNING' with a job_id. Returns the final result if finished, " +
      "otherwise 'STILL RUNNING' again: call it repeatedly until finished.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "job_id returned by opencode_coding." } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "opencode_list",
    description: "List opencode jobs that are queued, running, or finished but not yet collected (job_id, state, age, cwd, task preview). Use it before re-sending a task that seems to have produced nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "opencode_cancel",
    description: "Cancel a running opencode job (kills the process tree) and return what it had produced.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "job_id returned by opencode_coding." } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  args = args && typeof args === "object" ? args : {};
  switch (name) {
    case "opencode_coding":
      return waitForJob(startJob(args));
    case "opencode_wait":
      return waitForJob(getJob(args));
    case "opencode_list":
      return listJobs();
    case "opencode_cancel": {
      const job = getJob(args);
      job.ctl.abort();
      return waitForJob(job);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC / MCP plumbing                                             */
/* ------------------------------------------------------------------ */

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) never get a response.
  if (id === undefined || id === null) {
    // The client cancelling a request (its ~60s timeout) must NOT kill the job:
    // jobs outlive requests and are collected with opencode_wait.
    if (method === "notifications/cancelled" && params) log(`request ${params.requestId} cancelled by client (job keeps running)`);
    return;
  }

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params && params.name;
        const args = params && params.arguments;
        const { text, isError } = await callTool(name, args);
        reply(id, { content: [{ type: "text", text }], isError: Boolean(isError) });
        return;
      }
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    log("tool error:", message);
    reply(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "").trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("failed to parse line:", line.slice(0, 200));
      continue;
    }
    handleMessage(msg).catch((err) => log("handler crash:", err && err.message ? err.message : String(err)));
  }
});

process.stdin.on("end", () => {
  // Client is gone: nobody can read results, so kill running opencode trees and exit
  // instead of lingering as an orphan.
  log("stdin closed, shutting down");
  for (const job of jobs.values()) job.ctl.abort();
  setTimeout(() => process.exit(0), 1500);
});
log(`started (tool=opencode_coding, model=${CONFIG.opencodeModel})`);
