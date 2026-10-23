'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  deriveStealthKeys,
  deriveStealthKeysFromSigner,
  buildStealthPayment,
  resolveStellarName,
  type StealthKeys,
  type StellarStealthSigner,
  type BuildStealthPaymentOptions,
  type ResolveStellarNameOptions,
} from '@wraith-protocol/sdk/chains/stellar';
import { Horizon } from '@stellar/stellar-sdk';
import { getUnknownErrorMessage } from '@wraith-protocol/sdk';
import { getPlatform, setPlatform, type Platform } from './platform';

export { getPlatform, setPlatform };
export type { Platform };

export { useScanner } from './hooks/useScanner';

/** Hook to generate and manage stealth keys */
export function useStellarStealthKeys() {
  const [keys, setKeys] = useState<StealthKeys | null>(null);

  const generate = useCallback((signature: Uint8Array) => {
    const derived = deriveStealthKeys(signature);
    setKeys(derived);
    return derived;
  }, []);

  const generateFromSigner = useCallback(async (signer: StellarStealthSigner) => {
    const derived = await deriveStealthKeysFromSigner(signer);
    setKeys(derived);
    return derived;
  }, []);

  return { keys, generate, generateFromSigner };
}

/** Hook to send stealth payments */
export function useStellarSendStealthPayment() {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const build = useCallback(async (options: BuildStealthPaymentOptions) => {
    setBuilding(true);
    setError(null);
    try {
      const result = await buildStealthPayment(options);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(getUnknownErrorMessage(err)));
      throw err;
    } finally {
      setBuilding(false);
    }
  }, []);

  return { building, error, build };
}

/** Hook to get stellar balance */
export function useStellarBalance(publicKey: string, rpcUrl = 'https://horizon.stellar.org') {
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) return;
    let mounted = true;
    setLoading(true);

    const server = new Horizon.Server(rpcUrl);
    server
      .loadAccount(publicKey)
      .then((acc) => {
        if (!mounted) return;
        const xlmBalance = acc.balances.find((balance) => balance.asset_type === 'native');
        setBalance(xlmBalance ? xlmBalance.balance : '0');
      })
      .catch(() => {
        if (mounted) setBalance('0');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [publicKey, rpcUrl]);

  return { balance, loading };
}

export function useStellarName(
  name: string | undefined,
  chain?: string,
  options?: ResolveStellarNameOptions,
): { address: string | null; loading: boolean; error: Error | null };
/** Hook to resolve a Wraith name on Stellar */
export function useStellarName(name: string | undefined, chain = 'stellar') {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // eslint-disable-next-line prefer-rest-params
  const options = arguments[2] as ResolveStellarNameOptions | undefined;
  const rpcUrl = options?.rpcUrl;
  const contractId = options?.contractId;
  const networkPassphrase = options?.networkPassphrase;
  const bypassCache = options?.bypassCache;
  const ttlMs = options?.ttlMs;
  const throwOnNotFound = options?.throwOnNotFound;
  const callerSignal = options?.signal;

  useEffect(() => {
    if (name === undefined) {
      setAddress(null);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);

    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    async function resolve() {
      setLoading(true);
      setError(null);
      setAddress(null);
      try {
        const resolved = await resolveStellarName(name!, chain, {
          rpcUrl,
          contractId,
          networkPassphrase,
          bypassCache,
          ttlMs,
          throwOnNotFound,
          signal: controller.signal,
        });
        if (mounted && resolved !== null) {
          setAddress(resolved);
          return;
        }
        if (!mounted) return;
        setAddress(null); // Return null or resolved meta-address
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error(getUnknownErrorMessage(err)));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    resolve();
    return () => {
      mounted = false;
      callerSignal?.removeEventListener('abort', onCallerAbort);
      controller.abort();
    };
  }, [
    name,
    chain,
    rpcUrl,
    contractId,
    networkPassphrase,
    bypassCache,
    ttlMs,
    throwOnNotFound,
    callerSignal,
  ]);

  return { address, loading, error };
}
