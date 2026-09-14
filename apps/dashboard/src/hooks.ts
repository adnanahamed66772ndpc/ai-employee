import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainChange } from "./api.ts";

type Listener = (change: BrainChange) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect(): void {
  if (source) return;
  source = new EventSource("/api/stream");
  source.addEventListener("change", (event) => {
    const change = JSON.parse((event as MessageEvent<string>).data) as BrainChange;
    for (const listener of listeners) listener(change);
  });
}

/** Returns a counter that bumps (debounced) whenever the server reports a matching brain change. */
export function useLive(match: (change: BrainChange) => boolean): number {
  const [version, setVersion] = useState(0);
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    connect();
    let timer: number | undefined;
    const listener: Listener = (change) => {
      if (!matchRef.current(change)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVersion((v) => v + 1), 150);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      window.clearTimeout(timer);
    };
  }, []);
  return version;
}

/** Loads data and reloads whenever a dependency (including a live version) changes. */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    load()
      .then((value) => {
        if (!active) return;
        setData(value);
        setError(null);
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}

export function useRoute(): string[] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

/** Wraps an async action with a busy flag and an error message for forms and buttons. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
