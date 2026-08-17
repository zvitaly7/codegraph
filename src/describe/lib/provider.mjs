// Bring your own model.
//
// Every provider is the SAME one-method interface:
//
//     describeOne(prompt) -> Promise<string>
//
// so adding another is one function plus one row in `resolveProvider`. It
// either returns the description text or throws; the run loop turns a throw
// into a recorded failure for that one item and carries on.
//
// Precedence, highest first:
//   1. `--command "<shell command>"` (or `describe.command` in the config).
//      loregraph writes the prompt to the process's STDIN and reads the
//      description from its STDOUT. This is the recommended path: anyone who
//      already pays for a CLI or a subscription uses it instead of paying a
//      second time for API tokens.
//   2. `ANTHROPIC_API_KEY` → the Anthropic Messages API.
//   3. `OPENAI_API_KEY`    → the OpenAI chat completions API.
//   4. nothing → a clear error naming all three options. Never a silent
//      failure, and never a fabricated description.
//
// `fetch` only — no SDK, so `loregraph` keeps its two runtime dependencies.

import { spawn } from 'node:child_process';
import process from 'node:process';

/** Provider ids, in precedence order. */
export const PROVIDERS = ['command', 'anthropic', 'openai'];

/** Sane default model per API provider (override with --model / describe.model). */
export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o-mini',
};

/**
 * What a `--command` provider records as its model when the user did not say.
 * Passing `--model` makes the stored description name the model it really used.
 */
export const UNSPECIFIED_MODEL = 'unspecified';

/** Hard cap on generated length — the ask is 1-2 sentences. */
export const MAX_OUTPUT_TOKENS = 200;

/** Default per-item timeout. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Printed when no provider is configured. Exit code 2. */
export const NO_PROVIDER_ERROR = [
  'describe: no model provider configured. Pick one:',
  '',
  '  1. Use a CLI you already pay for (recommended — no API tokens billed):',
  '       loregraph describe --command "your-llm-cli --quiet"',
  '     loregraph writes the prompt to the command\'s stdin and reads the',
  '     description from its stdout. Set `describe.command` in loregraph.config.mjs',
  '     to make it the default.',
  '',
  '  2. Anthropic API:  export ANTHROPIC_API_KEY=...   (model: --model, default '
    + `${DEFAULT_MODELS.anthropic})`,
  '',
  `  3. OpenAI API:     export OPENAI_API_KEY=...      (model: --model, default ${DEFAULT_MODELS.openai})`,
  '',
  'Nothing was generated and nothing was spent.',
].join('\n');

// ---- the shell-command provider -----------------------------------------

/**
 * Run `command` through the shell, write `prompt` to its stdin, resolve with
 * its stdout.
 *
 * A non-zero exit, an empty stdout or a timeout all reject — an empty answer is
 * a failure, not a description.
 */
function commandDescribeOne(command, { timeoutMs, spawnImpl = spawn }) {
  return (prompt) => new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`could not start command: ${err?.message ?? err}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish(reject, new Error(`command failed to run: ${err?.message ?? err}`)));
    child.on('close', (code) => {
      const text = stdout.trim();
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        finish(reject, new Error(`command exited ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (text.length === 0) {
        finish(reject, new Error('command wrote nothing to stdout'));
        return;
      }
      finish(resolvePromise, text);
    });

    // A command that never reads stdin (or exits first) must not crash us.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(prompt);
    } catch { /* the close handler reports what actually happened */ }
  });
}

// ---- the HTTP providers -------------------------------------------------

/** An abort signal that fires after `ms`, on any Node >= 18. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
}

async function readError(res) {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Anthropic Messages API.
 *
 * Thinking is switched off: the ask is one or two sentences, and thinking
 * tokens on a 30-token answer are the user's money spent for nothing. A model
 * that refuses to run without thinking reports its own API error, which we
 * surface verbatim.
 */
function anthropicDescribeOne(apiKey, model, { timeoutMs, fetchImpl }) {
  return async (prompt) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await readError(res)}`);
    const data = await res.json();
    const text = (data?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text.length === 0) throw new Error(`anthropic returned no text (stop_reason: ${data?.stop_reason ?? 'unknown'})`);
    return text;
  };
}

/** OpenAI chat completions. */
function openaiDescribeOne(apiKey, model, { timeoutMs, fetchImpl }) {
  return async (prompt) => {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await readError(res)}`);
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (text.length === 0) {
      throw new Error(`openai returned no content (finish_reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'})`);
    }
    return text;
  };
}

// ---- resolution ---------------------------------------------------------

/**
 * Pick a provider by the documented precedence.
 *
 * @param {object} [opts]
 * @param {string} [opts.command] the `--command` / `describe.command` shell command.
 * @param {string} [opts.model] explicit model id.
 * @param {object} [opts.env] environment to read keys from (default process.env).
 * @param {number} [opts.timeoutMs] per-item timeout.
 * @param {Function} [opts.fetchImpl] injected for tests — no real network in the suite.
 * @param {Function} [opts.spawnImpl] injected for tests.
 * @returns {{ok: true, provider: string, model: string, describeOne: Function, detail: string}
 *   | {ok: false, error: string}}
 */
export function resolveProvider({
  command, model, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch, spawnImpl = spawn,
} = {}) {
  const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  if (typeof command === 'string' && command.trim().length > 0) {
    return {
      ok: true,
      provider: 'command',
      model: model || UNSPECIFIED_MODEL,
      detail: command.trim(),
      describeOne: commandDescribeOne(command.trim(), { timeoutMs: timeout, spawnImpl }),
    };
  }

  if (typeof env?.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0) {
    const chosen = model || DEFAULT_MODELS.anthropic;
    return {
      ok: true,
      provider: 'anthropic',
      model: chosen,
      detail: 'ANTHROPIC_API_KEY',
      describeOne: anthropicDescribeOne(env.ANTHROPIC_API_KEY, chosen, { timeoutMs: timeout, fetchImpl }),
    };
  }

  if (typeof env?.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0) {
    const chosen = model || DEFAULT_MODELS.openai;
    return {
      ok: true,
      provider: 'openai',
      model: chosen,
      detail: 'OPENAI_API_KEY',
      describeOne: openaiDescribeOne(env.OPENAI_API_KEY, chosen, { timeoutMs: timeout, fetchImpl }),
    };
  }

  return { ok: false, error: NO_PROVIDER_ERROR };
}
