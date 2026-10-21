/**
 * `@raycast/utils` essentials for Glide: usePromise, useCachedPromise, useFetch, useCachedState,
 * useLocalStorage, useForm, useExec, getFavicon, showFailureToast, runAppleScript and helpers.
 *
 * Self-contained (serialised with Function.prototype.toString into the extension runner).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createRaycastUtils(React: Record<string, any>, api: Record<string, any>, nodeRequire: (id: string) => any): Record<string, any> {
  const { useState, useEffect, useRef, useCallback, useMemo } = React;

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function showFailureToast(error: unknown, options?: { title?: string; message?: string; primaryAction?: unknown }) {
    return api.showToast({ style: api.Toast.Style.Failure, title: options?.title ?? "Something went wrong", message: options?.message ?? errMsg(error), primaryAction: options?.primaryAction });
  }

  /** Latest value in a ref (callbacks read it without re-subscribing). */
  function useLatest<T>(v: T) {
    const r = useRef(v);
    r.current = v;
    return r;
  }

  const stableKey = (args: unknown[]) => {
    try {
      return JSON.stringify(args, (_k, v) => (typeof v === "function" ? `fn:${String(v).length}` : v instanceof Date ? `date:${v.toISOString()}` : v));
    } catch {
      return String(Math.random());
    }
  };

  /**
   * usePromise(fn, args, options). When fn(...args) returns a function, it is a paginated source:
   * page loader `(opts: { page, cursor, lastItem }) => Promise<{ data: T[], hasMore, cursor? }>`.
   */
  function usePromise(fn: (...a: any[]) => any, args: unknown[] = [], options: Record<string, any> = {}) {
    const latest = useLatest({ fn, args, options });
    const [state, setState] = useState(() => ({ data: options.initialData, error: undefined as unknown, isLoading: options.execute !== false }));
    const callId = useRef(0);
    const abort = useRef(null as AbortController | null);
    const page = useRef({ page: 0, cursor: undefined as unknown, hasMore: false, paginated: false });
    const [hasMore, setHasMore] = useState(false);
    const key = stableKey(args);

    const run = useCallback(async (mode: "reset" | "more" = "reset") => {
      const { fn: f, args: a, options: o } = latest.current;
      const id = ++callId.current;
      if (o.abortable) {
        abort.current?.abort();
        abort.current = new AbortController();
        o.abortable.current = abort.current;
      }
      o.onWillExecute?.(a);
      setState((s: any) => ({ ...s, isLoading: true }));
      try {
        let result = f(...a);
        if (typeof result === "function") {
          page.current.paginated = true;
          if (mode === "reset") page.current = { page: 0, cursor: undefined, hasMore: false, paginated: true };
          const p = page.current;
          const prev: unknown[] = mode === "more" && Array.isArray((stateRef.current as any).data) ? (stateRef.current as any).data : [];
          const res = await result({ page: p.page, cursor: p.cursor, lastItem: prev[prev.length - 1] });
          if (id !== callId.current) return;
          const items = Array.isArray(res?.data) ? res.data : [];
          p.page += 1;
          p.cursor = res?.cursor;
          p.hasMore = !!res?.hasMore;
          setHasMore(p.hasMore);
          const data = mode === "more" ? [...prev, ...items] : items;
          setState({ data, error: undefined, isLoading: false });
          o.onData?.(data, { page: p.page - 1 });
          return data;
        }
        result = await result;
        if (id !== callId.current) return;
        setState({ data: result, error: undefined, isLoading: false });
        o.onData?.(result);
        return result;
      } catch (err) {
        if (id !== callId.current) return;
        if (err && (err as { name?: string }).name === "AbortError") return;
        setState((s: any) => ({ ...s, error: err, isLoading: false }));
        if (o.onError) o.onError(err);
        else if (o.failureToastOptions !== false) void showFailureToast(err, { title: "Failed to fetch latest data", ...(o.failureToastOptions ?? {}) });
        throw err;
      }
    }, []);
    const stateRef = useLatest(state);

    useEffect(() => {
      if (latest.current.options.execute === false) {
        setState((s: any) => (s.isLoading ? { ...s, isLoading: false } : s));
        return;
      }
      run("reset").catch(() => undefined);
    }, [key, options.execute !== false]);

    useEffect(() => () => abort.current?.abort(), []);

    const revalidate = useCallback(() => run("reset"), [run]);
    const mutate = useCallback(async (asyncUpdate?: Promise<unknown>, opts?: { optimisticUpdate?: (d: any) => any; rollbackOnError?: boolean | ((d: any) => any); shouldRevalidateAfter?: boolean }) => {
      const before = stateRef.current.data;
      if (opts?.optimisticUpdate) setState((s: any) => ({ ...s, data: opts.optimisticUpdate!(s.data) }));
      try {
        const r = await asyncUpdate;
        if (opts?.shouldRevalidateAfter !== false) await run("reset").catch(() => undefined);
        return r;
      } catch (err) {
        if (opts?.optimisticUpdate && opts.rollbackOnError !== false)
          setState((s: any) => ({ ...s, data: typeof opts.rollbackOnError === "function" ? opts.rollbackOnError(s.data) : before }));
        throw err;
      }
    }, []);

    const pagination = page.current.paginated
      ? {
          pageSize: options.pageSize ?? 20,
          hasMore,
          onLoadMore: () => {
            if (page.current.hasMore && !stateRef.current.isLoading) run("more").catch(() => undefined);
          },
        }
      : undefined;

    return { data: state.data, error: state.error, isLoading: state.isLoading, revalidate, mutate, pagination };
  }

  function cacheFor(namespace?: string) {
    return new api.Cache({ namespace: namespace ?? "raycast-utils" });
  }

  function useCachedPromise(fn: (...a: any[]) => any, args: unknown[] = [], options: Record<string, any> = {}) {
    const cache = useMemo(() => cacheFor(options.cacheNamespace), []);
    const key = `promise:${String(fn).length}:${String(fn).slice(0, 64)}:${stableKey(args)}`;
    const cached = useMemo(() => {
      const raw = cache.get(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }, [key]);
    const lastData = useRef(cached ?? options.initialData);
    const res = usePromise(fn, args, {
      ...options,
      initialData: cached ?? options.initialData,
      onData: (d: unknown, info?: unknown) => {
        lastData.current = d;
        try {
          if (!info) cache.set(key, JSON.stringify(d));
        } catch {
          /* not serialisable */
        }
        options.onData?.(d, info);
      },
    });
    let data = res.data;
    if (data === undefined && res.isLoading) data = options.keepPreviousData ? lastData.current : (cached ?? options.initialData);
    return { ...res, data };
  }

  async function defaultParse(response: Response) {
    const type = response.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const msg = typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : response.statusText;
      throw new Error(`${response.status} ${msg}`.trim());
    }
    return body;
  }

  function useFetch(url: string | ((opts: { page: number; cursor?: unknown; lastItem?: unknown }) => string), options: Record<string, any> = {}) {
    const { parseResponse, mapResult, initialData, keepPreviousData, execute, onError, onData, onWillExecute, failureToastOptions, ...init } = options;
    const latest = useLatest({ parseResponse, mapResult, init });
    const paginated = typeof url === "function";
    const fetcher = useCallback(
      (u: unknown, initKey: string) => {
        void initKey;
        const load = async (target: string) => {
          const { parseResponse: parse, mapResult: map, init: i } = latest.current;
          const response = await fetch(target, i);
          const parsed = await (parse ?? defaultParse)(response);
          return map ? map(parsed) : parsed;
        };
        if (typeof u === "function") return async (pg: { page: number; cursor?: unknown; lastItem?: unknown }) => load((u as (p: typeof pg) => string)(pg));
        return load(String(u)).then((r: any) => (latest.current.mapResult && r && typeof r === "object" && "data" in r ? r.data : r));
      },
      [],
    );
    // A paginated URL function is keyed by its first page's URL, so a new query refetches from page 0.
    const firstPage = paginated ? (url as (o: { page: number }) => string)({ page: 0 }) : String(url);
    const res = useCachedPromise(fetcher, [paginated ? url : String(url), stableKey([firstPage, init.method, init.body, init.headers])], {
      initialData,
      keepPreviousData,
      execute,
      onError,
      onData,
      onWillExecute,
      failureToastOptions,
      cacheNamespace: options.cacheNamespace,
    });
    return res;
  }

  function useCachedState<T>(key: string, initialState?: T, config?: { cacheNamespace?: string }) {
    const cache = useMemo(() => cacheFor(config?.cacheNamespace ?? "cached-state"), []);
    const read = () => {
      const raw = cache.get(key);
      if (raw === undefined) return initialState;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return initialState;
      }
    };
    const [value, setValue] = useState(read);
    useEffect(() => setValue(read()), [key]);
    useEffect(
      () =>
        cache.subscribe((k: string | undefined) => {
          if (k === key || k === undefined) setValue(read());
        }),
      [key],
    );
    const set = useCallback(
      (v: T | ((prev: T) => T)) => {
        setValue((prev: T) => {
          const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
          try {
            cache.set(key, JSON.stringify(next));
          } catch {
            /* not serialisable */
          }
          return next;
        });
      },
      [key],
    );
    return [value, set];
  }

  function useLocalStorage<T>(key: string, initialValue?: T) {
    const { data, isLoading, mutate } = usePromise(
      async (k: string) => {
        const raw = await api.LocalStorage.getItem(k);
        if (raw === undefined) return initialValue;
        try {
          return JSON.parse(String(raw)) as T;
        } catch {
          return raw as T;
        }
      },
      [key],
    );
    const setValue = useCallback(async (v: T) => mutate(api.LocalStorage.setItem(key, JSON.stringify(v)), { optimisticUpdate: () => v }), [key]);
    const removeValue = useCallback(async () => mutate(api.LocalStorage.removeItem(key), { optimisticUpdate: () => undefined }), [key]);
    return { value: data as T | undefined, setValue, removeValue, isLoading };
  }

  const FormValidation = { Required: "required" };

  function useForm(props: { onSubmit: (values: Record<string, any>) => unknown; validation?: Record<string, unknown>; initialValues?: Record<string, any> }) {
    const latest = useLatest(props);
    const [values, setValues] = useState(() => ({ ...(props.initialValues ?? {}) }));
    const [errors, setErrors] = useState({} as Record<string, string | undefined>);
    const valuesRef = useLatest(values);
    const refs = useRef({} as Record<string, { current: any }>);

    const validateOne = (id: string, value: unknown): string | undefined => {
      const rule = latest.current.validation?.[id];
      if (!rule) return undefined;
      if (rule === FormValidation.Required) {
        const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || value === false;
        return empty ? "The item is required" : undefined;
      }
      if (typeof rule === "function") {
        const r = (rule as (v: unknown) => string | undefined | null)(value);
        return r ?? undefined;
      }
      return undefined;
    };

    const handleSubmit = useCallback(async (submitted?: Record<string, any>) => {
      const merged = { ...valuesRef.current, ...(submitted ?? {}) };
      const next: Record<string, string | undefined> = {};
      let failed = false;
      for (const id of Object.keys(latest.current.validation ?? {})) {
        const e = validateOne(id, merged[id]);
        if (e) {
          next[id] = e;
          failed = true;
        }
      }
      setErrors(next);
      if (failed) return false;
      return latest.current.onSubmit(merged);
    }, []);

    const itemProps = new Proxy({} as Record<string, unknown>, {
      get: (_t, id) => {
        if (typeof id !== "string") return undefined;
        refs.current[id] ??= { current: null };
        return {
          id,
          value: values[id],
          error: errors[id],
          ref: refs.current[id],
          onChange: (v: unknown) => {
            setValues((s: Record<string, unknown>) => ({ ...s, [id]: v }));
            if (errors[id]) setErrors((s: Record<string, string | undefined>) => ({ ...s, [id]: validateOne(id, v) }));
          },
          onBlur: (e: { target?: { value?: unknown } }) => {
            const err = validateOne(id, e?.target?.value ?? valuesRef.current[id]);
            setErrors((s: Record<string, string | undefined>) => ({ ...s, [id]: err }));
          },
        };
      },
    });

    return {
      handleSubmit,
      itemProps,
      values,
      setValidationError: (id: string, error: string | undefined) => setErrors((s: Record<string, string | undefined>) => ({ ...s, [id]: error })),
      setValue: (id: string, v: unknown) => setValues((s: Record<string, unknown>) => ({ ...s, [id]: v })),
      reset: (vals?: Record<string, unknown>) => {
        setValues({ ...(vals ?? latest.current.initialValues ?? {}) });
        setErrors({});
      },
      focus: (id: string) => refs.current[id]?.current?.focus?.(),
    };
  }

  function useExec(command: string, argsOrOptions?: unknown, maybeOptions?: Record<string, any>) {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : (argsOrOptions as Record<string, any>)) ?? {};
    const { parseOutput, shell, input, env, cwd, timeout, ...rest } = options;
    return usePromise(
      (cmd: string, a: string[]) =>
        new Promise((resolve, reject) => {
          const cp = nodeRequire("node:child_process");
          const child = cp.execFile(shell ? "/bin/sh" : cmd, shell ? ["-c", [cmd, ...a].join(" ")] : a, { env: env ? { ...process.env, ...env } : undefined, cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
            if (err) return reject(new Error(stderr?.trim() || err.message));
            resolve(parseOutput ? parseOutput({ stdout, stderr, exitCode: 0 }) : stdout.trim());
          });
          if (input !== undefined) child.stdin?.end(String(input));
        }),
      [command, args],
      rest,
    );
  }

  function runAppleScript(script: string, argsOrOptions?: unknown, maybeOptions?: Record<string, any>) {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : (argsOrOptions as Record<string, any>)) ?? {};
    return new Promise<string>((resolve, reject) => {
      const cp = nodeRequire("node:child_process");
      const lang = options.language === "JavaScript" ? ["-l", "JavaScript"] : [];
      const child = cp.execFile("/usr/bin/osascript", [...lang, "-", ...args], { timeout: options.timeout ?? 10_000 }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout.replace(/\n$/, ""));
      });
      child.stdin?.end(script);
    });
  }

  function getFavicon(url: string | URL, options?: { size?: number; fallback?: string; mask?: string }) {
    try {
      const host = new URL(String(url)).hostname;
      return { source: `https://www.google.com/s2/favicons?sz=${options?.size ?? 64}&domain=${encodeURIComponent(host)}`, fallback: options?.fallback ?? api.Icon.Globe, mask: options?.mask };
    } catch {
      return options?.fallback ?? api.Icon.Globe;
    }
  }

  function getAvatarIcon(name: string) {
    const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  }

  function getProgressIcon(progress: number) {
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    return p >= 1 ? api.Icon.CircleProgress100 : p >= 0.75 ? api.Icon.CircleProgress75 : p >= 0.5 ? api.Icon.CircleProgress50 : p > 0 ? api.Icon.CircleProgress25 : api.Icon.Circle;
  }

  /** useAI: streams AI.ask into `data` (Glide's AI feature answers). */
  function useAI(prompt: string, options: Record<string, any> = {}) {
    const [data, setData] = useState("");
    const latest = useLatest(options);
    const res = usePromise(
      async (p: string, creativity: unknown, model: unknown) => {
        setData("");
        const stream = options.stream !== false;
        const task = api.AI.ask(p, { creativity, model });
        if (stream) task.on("data", (chunk: string) => setData((d: string) => d + chunk));
        const full = await task;
        setData(full);
        return full;
      },
      [prompt, options.creativity, options.model],
      { execute: options.execute, onData: (d: string) => latest.current.onData?.(d), onError: options.onError, onWillExecute: options.onWillExecute, failureToastOptions: options.failureToastOptions },
    );
    return { ...res, data };
  }

  // --- OAuth -------------------------------------------------------------------------------------
  const tokens: { current?: string; idToken?: string } = {};

  /** Generic OAuthService (PKCE authorization code flow + refresh) on top of OAuth.PKCEClient. */
  class OAuthService {
    client: any;
    clientId: string;
    scope: string;
    authorizeUrl: string;
    tokenUrl: string;
    refreshTokenUrl?: string;
    personalAccessToken?: string;
    extraParameters?: Record<string, string>;
    bodyEncoding: "json" | "url-encoded";
    onAuthorize?: (p: { token: string; type: string; idToken?: string }) => unknown;
    tokenResponseParser: (r: unknown) => Record<string, any>;
    tokenRefreshResponseParser: (r: unknown) => Record<string, any>;
    constructor(o: Record<string, any>) {
      this.client = o.client;
      this.clientId = String(o.clientId ?? "");
      this.scope = Array.isArray(o.scope) ? o.scope.join(" ") : String(o.scope ?? "");
      this.authorizeUrl = String(o.authorizeUrl ?? "");
      this.tokenUrl = String(o.tokenUrl ?? "");
      if (o.refreshTokenUrl) this.refreshTokenUrl = String(o.refreshTokenUrl);
      if (o.personalAccessToken) this.personalAccessToken = String(o.personalAccessToken);
      this.extraParameters = o.extraParameters;
      this.bodyEncoding = o.bodyEncoding === "url-encoded" ? "url-encoded" : "json";
      this.onAuthorize = o.onAuthorize;
      this.tokenResponseParser = o.tokenResponseParser ?? ((r: unknown) => r as Record<string, any>);
      this.tokenRefreshResponseParser = o.tokenRefreshResponseParser ?? ((r: unknown) => r as Record<string, any>);
    }
    private async post(url: string, body: Record<string, string>) {
      const json = this.bodyEncoding === "json";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded", Accept: "application/json" },
        body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
      });
      if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      return res.json();
    }
    async authorize(): Promise<string> {
      if (this.personalAccessToken) {
        tokens.current = this.personalAccessToken;
        await this.onAuthorize?.({ token: this.personalAccessToken, type: "personal" });
        return this.personalAccessToken;
      }
      const set = await this.client.getTokens();
      if (set?.accessToken) {
        if (set.refreshToken && set.isExpired()) {
          const raw = await this.post(this.refreshTokenUrl ?? this.tokenUrl, { client_id: this.clientId, refresh_token: set.refreshToken, grant_type: "refresh_token" });
          const parsed = this.tokenRefreshResponseParser(raw);
          await this.client.setTokens({ ...parsed, refresh_token: parsed.refresh_token ?? set.refreshToken });
          const next = await this.client.getTokens();
          tokens.current = next?.accessToken;
          tokens.idToken = next?.idToken;
          await this.onAuthorize?.({ token: next.accessToken, type: "oauth", idToken: next.idToken });
          return next.accessToken;
        }
        tokens.current = set.accessToken;
        tokens.idToken = set.idToken;
        await this.onAuthorize?.({ token: set.accessToken, type: "oauth", idToken: set.idToken });
        return set.accessToken;
      }
      const request = await this.client.authorizationRequest({ endpoint: this.authorizeUrl, clientId: this.clientId, scope: this.scope, extraParameters: this.extraParameters });
      const { authorizationCode } = await this.client.authorize(request);
      const raw = await this.post(this.tokenUrl, { client_id: this.clientId, code: authorizationCode, code_verifier: request.codeVerifier, grant_type: "authorization_code", redirect_uri: request.redirectURI });
      await this.client.setTokens(this.tokenResponseParser(raw));
      const next = await this.client.getTokens();
      tokens.current = next?.accessToken;
      tokens.idToken = next?.idToken;
      await this.onAuthorize?.({ token: next.accessToken, type: "oauth", idToken: next.idToken });
      return next.accessToken;
    }
  }

  /**
   * withAccessToken(service)(Component | async function): authorizes before the command renders
   * (view commands) or runs (no-view), then getAccessToken() returns the token.
   */
  function withAccessToken(options: Record<string, any>) {
    const authorize = () => (typeof options?.authorize === "function" ? options.authorize() : Promise.reject(new Error("withAccessToken needs an OAuthService or { authorize }")));
    return (Command: any) => {
      if (api.environment.commandMode === "no-view") {
        return async (props: unknown) => {
          const token = await authorize();
          tokens.current = token;
          await options.onAuthorize?.({ token, type: options.personalAccessToken ? "personal" : "oauth" });
          return Command(props);
        };
      }
      function WithAccessToken(props: Record<string, any>) {
        const [token, setToken] = useState(tokens.current);
        const [error, setError] = useState(undefined as unknown);
        useEffect(() => {
          if (token) return;
          authorize().then(
            (t: string) => {
              tokens.current = t;
              setToken(t);
            },
            (err: unknown) => setError(err),
          );
        }, []);
        if (error) throw error;
        if (!token) return React.createElement(api.Detail, { isLoading: true, markdown: "" });
        return React.createElement(Command, props);
      }
      return WithAccessToken;
    };
  }

  function getAccessToken() {
    if (!tokens.current) throw new Error("getAccessToken must be used inside a command wrapped with withAccessToken(…)");
    return { token: tokens.current, type: "oauth", idToken: tokens.idToken };
  }

  const unsupported = (name: string) => () => {
    throw new Error(`${name} is not supported in Glide's Raycast compatibility layer yet`);
  };

  const utils: Record<string, any> = {
    usePromise,
    useCachedPromise,
    useFetch,
    useCachedState,
    useLocalStorage,
    useForm,
    useExec,
    FormValidation,
    showFailureToast,
    runAppleScript,
    getFavicon,
    getAvatarIcon,
    getProgressIcon,
    createDeeplink: (o: { command?: string; extensionName?: string }) => `raycast://extensions/glide/${o?.extensionName ?? ""}/${o?.command ?? ""}`,
    useStreamJSON: unsupported("useStreamJSON"),
    useSQL: unsupported("useSQL"),
    useAI,
    useFrecencySorting: (data: unknown[] | undefined) => ({ data: data ?? [], visitItem: async () => undefined, resetRanking: async () => undefined }),
    withAccessToken,
    getAccessToken,
    OAuthService,
  };
  utils.default = utils;
  return utils;
}
