import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  resolveProvider, PROVIDERS, DEFAULT_MODELS, UNSPECIFIED_MODEL, NO_PROVIDER_ERROR,
} from './provider.mjs';

/** A tiny node script used as a fake `--command` provider — no network, ever. */
function fakeCli(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lg-desc-cli-'));
  const path = join(dir, 'fake.mjs');
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}

const ECHO_CLI = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  process.stdout.write('FAKE: prompt was ' + input.length + ' chars\\n');
});
`;

const FAIL_CLI = `
process.stderr.write('boom: the model is on fire\\n');
process.exit(3);
`;

const EMPTY_CLI = 'process.stdout.write("");\n';

const SLOW_CLI = 'setTimeout(() => process.stdout.write("late"), 5000);\n';

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('provider precedence', () => {
  it('prefers --command over both API keys', () => {
    const res = resolveProvider({
      command: 'my-cli',
      env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
    });
    expect(res).toMatchObject({ ok: true, provider: 'command', detail: 'my-cli' });
  });

  it('falls back to Anthropic when only ANTHROPIC_API_KEY is set', () => {
    const res = resolveProvider({ env: { ANTHROPIC_API_KEY: 'a' } });
    expect(res).toMatchObject({ ok: true, provider: 'anthropic', model: DEFAULT_MODELS.anthropic });
  });

  it('prefers Anthropic over OpenAI when both keys are set', () => {
    const res = resolveProvider({ env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' } });
    expect(res.provider).toBe('anthropic');
  });

  it('falls back to OpenAI when only OPENAI_API_KEY is set', () => {
    const res = resolveProvider({ env: { OPENAI_API_KEY: 'o' } });
    expect(res).toMatchObject({ ok: true, provider: 'openai', model: DEFAULT_MODELS.openai });
  });

  it('--model overrides the default for every provider', () => {
    expect(resolveProvider({ env: { ANTHROPIC_API_KEY: 'a' }, model: 'custom-1' }).model).toBe('custom-1');
    expect(resolveProvider({ env: { OPENAI_API_KEY: 'o' }, model: 'custom-2' }).model).toBe('custom-2');
    expect(resolveProvider({ command: 'x', model: 'my-local-model' }).model).toBe('my-local-model');
  });

  it('records an unspecified model for --command when none is given', () => {
    expect(resolveProvider({ command: 'x' }).model).toBe(UNSPECIFIED_MODEL);
  });

  it('ignores an empty command and empty keys', () => {
    expect(resolveProvider({ command: '   ', env: {} }).ok).toBe(false);
    expect(resolveProvider({ env: { ANTHROPIC_API_KEY: '' } }).ok).toBe(false);
  });

  it('errors helpfully when nothing is configured, naming all three options', () => {
    const res = resolveProvider({ env: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(NO_PROVIDER_ERROR);
    expect(res.error).toContain('--command');
    expect(res.error).toContain('ANTHROPIC_API_KEY');
    expect(res.error).toContain('OPENAI_API_KEY');
    expect(res.error).toContain('nothing was spent');
  });

  it('exposes the provider ids in precedence order', () => {
    expect(PROVIDERS).toEqual(['command', 'anthropic', 'openai']);
  });
});

describe('command provider', () => {
  it('writes the prompt to stdin and reads the description from stdout', async () => {
    const res = resolveProvider({ command: fakeCli(ECHO_CLI) });
    const text = await res.describeOne('hello prompt');
    expect(text).toBe('FAKE: prompt was 12 chars');
  });

  it('throws with the command stderr when it exits non-zero', async () => {
    const res = resolveProvider({ command: fakeCli(FAIL_CLI) });
    await expect(res.describeOne('p')).rejects.toThrow(/exited 3.*on fire/s);
  });

  it('treats empty stdout as a failure, not an empty description', async () => {
    const res = resolveProvider({ command: fakeCli(EMPTY_CLI) });
    await expect(res.describeOne('p')).rejects.toThrow(/wrote nothing to stdout/);
  });

  it('times out a hanging command', async () => {
    const res = resolveProvider({ command: fakeCli(SLOW_CLI), timeoutMs: 150 });
    await expect(res.describeOne('p')).rejects.toThrow(/timed out after 150ms/);
  });
});

describe('anthropic provider', () => {
  it('posts to the Messages API and returns the text blocks', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return jsonResponse({ content: [{ type: 'text', text: 'A cart screen.' }] });
    };
    const res = resolveProvider({ env: { ANTHROPIC_API_KEY: 'key-1' }, fetchImpl });
    expect(await res.describeOne('the prompt')).toBe('A cart screen.');
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.init.headers['x-api-key']).toBe('key-1');
    expect(seen.init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(seen.init.body);
    expect(body).toMatchObject({ model: DEFAULT_MODELS.anthropic, messages: [{ role: 'user', content: 'the prompt' }] });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('surfaces an HTTP error with its status and body', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
    const res = resolveProvider({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl });
    await expect(res.describeOne('p')).rejects.toThrow(/anthropic 401.*bad key/);
  });

  it('rejects an empty completion instead of storing one', async () => {
    const fetchImpl = async () => jsonResponse({ content: [], stop_reason: 'max_tokens' });
    const res = resolveProvider({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl });
    await expect(res.describeOne('p')).rejects.toThrow(/no text.*max_tokens/);
  });
});

describe('openai provider', () => {
  it('posts to chat completions and returns the message content', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return jsonResponse({ choices: [{ message: { content: ' A util module. ' } }] });
    };
    const res = resolveProvider({ env: { OPENAI_API_KEY: 'key-2' }, fetchImpl, model: 'gpt-test' });
    expect(await res.describeOne('the prompt')).toBe('A util module.');
    expect(seen.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen.init.headers.authorization).toBe('Bearer key-2');
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: 'gpt-test' });
  });

  it('surfaces an HTTP error', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    const res = resolveProvider({ env: { OPENAI_API_KEY: 'k' }, fetchImpl });
    await expect(res.describeOne('p')).rejects.toThrow(/openai 429.*rate limited/);
  });

  it('rejects an empty completion', async () => {
    const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    const res = resolveProvider({ env: { OPENAI_API_KEY: 'k' }, fetchImpl });
    await expect(res.describeOne('p')).rejects.toThrow(/no content.*length/);
  });
});
