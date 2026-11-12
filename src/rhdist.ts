import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Load a file from the installed `@roundhouseai/x402` package.
 *
 * 0.8.0 signs `upto` and `batch-settlement` inside `Engine`, but the package
 * entry only re-exports the exact-scheme builders (`exports` is `import` only,
 * so `require.resolve` cannot see it). The files below are in the published
 * tarball (`dist/core/*`). An absolute file URL bypasses that exports map.
 *
 * TODO(rh-x402#55): bump `@roundhouseai/x402` to the release that includes
 * https://github.com/roundhouseai-io/x402/pull/55 and call the public
 * `createEvmBatchPayment` export. Until that release, batch signing uses the
 * vendored channel client already shipped in 0.8.0, and `createEvmBatchPayment`
 * is used automatically when the installed build actually exports it.
 *
 * `import.meta.resolve` is missing under Vitest, and `require.resolve` cannot
 * see this package because its `exports` map has an `import` condition only.
 */
function x402Root(): string | undefined {
  const candidates: string[] = [];
  try {
    const from = fileURLToPath(import.meta.url);
    const require = createRequire(from);
    for (const dir of require.resolve.paths('@roundhouseai/x402') ?? []) {
      candidates.push(join(dir, '@roundhouseai', 'x402'));
    }
  } catch {
    /* a transformed import.meta.url is not a file path */
  }
  candidates.push(join(process.cwd(), 'node_modules', '@roundhouseai', 'x402'));
  return candidates.find((root) => existsSync(join(root, 'package.json')));
}

function entryFile(): string | undefined {
  const root = x402Root();
  if (!root) return undefined;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main?: string;
    exports?: { '.'?: { import?: string } };
  };
  const rel = pkg.exports?.['.']?.import ?? pkg.main ?? './dist/index.js';
  return join(root, rel);
}

export async function loadRhDist<T extends object>(relative: string): Promise<T | undefined> {
  const entry = entryFile();
  if (!entry) return undefined;
  const target = join(dirname(entry), relative);
  if (!existsSync(target)) return undefined;
  try {
    return (await import(pathToFileURL(target).href)) as T;
  } catch {
    return undefined;
  }
}

export interface BatchSupport {
  /** `createEvmBatchPayment` from PR #55 (not in 0.8.0). */
  pr55: boolean;
  /** Vendored `planChannelPayment` shipped in 0.8.0. */
  vendored: boolean;
}

let supportPromise: Promise<BatchSupport> | undefined;

export function batchSupport(): Promise<BatchSupport> {
  supportPromise ??= detectBatchSupport();
  return supportPromise;
}

async function detectBatchSupport(): Promise<BatchSupport> {
  const entry = await import('@roundhouseai/x402');
  const fromEntry = (entry as { createEvmBatchPayment?: unknown }).createEvmBatchPayment;
  if (typeof fromEntry === 'function') return { pr55: true, vendored: true };
  const batch = await loadRhDist<{ createEvmBatchPayment?: unknown }>('core/batchclient.js');
  const channel = await loadRhDist<{ planChannelPayment?: unknown }>('core/channel.js');
  return {
    pr55: typeof batch?.createEvmBatchPayment === 'function',
    vendored: typeof channel?.planChannelPayment === 'function',
  };
}

/** Test hook. Production never calls this. */
export function resetBatchSupportCache(): void {
  supportPromise = undefined;
}
