import { useCallback, useEffect, useState } from "react";

// ponytail: smallest data-fetch primitive that covers loading/error/refetch
// for every section. Upgrade to react-query if caching/mutation hooks are needed.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((v) => {
        if (alive) {
          setData(v);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);

  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((v) => {
        setData(v);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload };
}
