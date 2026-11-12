import { findChain, type PaymentOption, type SignerBackend } from '@roundhouseai/x402';
import { loadRhDist } from './rhdist.js';

interface Doc {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: { name: string; version?: string; chainId: number; verifyingContract: string };
  message: Record<string, unknown>;
}

interface PermitMod {
  EIP2612_GAS_SPONSORING_KEY: string;
  readPermit2Allowance(rpcUrl: string, token: string, owner: string): Promise<bigint>;
  readPermitNonce(rpcUrl: string, token: string, owner: string): Promise<bigint>;
  buildEip2612Permit(input: {
    option: PaymentOption;
    from: string;
    nonce: bigint;
    deadline: string;
  }): { typedData: Doc; info: Record<string, unknown> };
  buildUptoPermit2(input: {
    option: PaymentOption;
    from: string;
    now?: number;
  }): { typedData: Doc; authorization: Record<string, unknown> };
}

interface RpcMod {
  rpcUrlFor(chain: { network: string; rpcUrl: string }, overrides: Record<string, string>): string;
}

interface EipMod {
  wrapPaymentPayload(
    option: PaymentOption,
    payload: Record<string, unknown>,
    context: {
      x402Version: number;
      resource?: Record<string, unknown>;
      extensions?: Record<string, unknown>;
    },
  ): Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function permitModules(): Promise<{ permit: PermitMod; eip: EipMod }> {
  const permit = await loadRhDist<PermitMod>('core/permit2.js');
  const eip = await loadRhDist<EipMod>('core/eip3009.js');
  if (!permit?.buildUptoPermit2 || !eip?.wrapPaymentPayload) {
    throw new Error(
      'this @roundhouseai/x402 build cannot sign the upto scheme (permit2 client missing). Nothing was signed.',
    );
  }
  return { permit, eip };
}

/**
 * Sign the EIP-2612 permit a fresh wallet needs before Permit2 can move USDC.
 * No-op when the quote does not advertise `eip2612GasSponsoring`. Mirrors
 * rh-x402's engine: a failed allowance read still signs the permit; a failed
 * nonce read signs nothing.
 */
export async function signEip2612IfNeeded(input: {
  option: PaymentOption;
  signer: SignerBackend;
  from: string;
  extensions: Record<string, unknown> | undefined;
  amount: bigint;
  deadline: string;
  rpc: Record<string, string>;
}): Promise<Record<string, unknown> | undefined> {
  const { permit } = await permitModules();
  const key = permit.EIP2612_GAS_SPONSORING_KEY;
  if (!isRecord(input.extensions) || input.extensions[key] === undefined) return input.extensions;
  const chain = findChain(input.option.chain);
  const rpcMod = await loadRhDist<RpcMod>('core/rpc.js');
  if (!chain || !rpcMod) {
    throw new Error(`no RPC endpoint for ${input.option.network}. Nothing was signed.`);
  }
  const rpcUrl = rpcMod.rpcUrlFor(chain, input.rpc);
  let covered = false;
  try {
    covered = (await permit.readPermit2Allowance(rpcUrl, input.option.asset, input.from)) >= input.amount;
  } catch {
    covered = false;
  }
  if (covered) return input.extensions;
  const nonce = await permit.readPermitNonce(rpcUrl, input.option.asset, input.from);
  const built = permit.buildEip2612Permit({
    option: input.option,
    from: input.from,
    nonce,
    deadline: input.deadline,
  });
  const signature = await input.signer.signTypedData(built.typedData);
  return {
    ...input.extensions,
    [key]: { info: { ...built.info, signature } },
  };
}
