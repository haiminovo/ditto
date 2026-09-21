"use client";

import * as React from "react";
import { getDefaultRegistry } from "@/lib/sdk";

export interface ModelOption {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface UseProviderModelsParams {
  /** provider 键名，仅用于把元数据注册进 registry 时标注来源 */
  provider: string;
  providerType: string;
  baseURL: string;
  apiKey: string;
  /** 已保存的模型列表 —— 拉取失败时的兜底，也是「权威」的那一份 */
  savedModels?: string[];
  enabled: boolean;
}

export interface UseProviderModelsResult {
  /** 接口返回的原始结果；失败或未拉取时为 null */
  fetched: ModelOption[] | null;
  /** 实际可用的模型 id：拉到了用拉到的，否则用已保存的 */
  available: string[];
  source: "fetched" | "saved" | "none";
  loading: boolean;
  error: string | null;
  warnings: string[];
  /** 手动重试。会绕过防抖与「失败后不自动重试」的抑制。 */
  refresh: () => void;
}

/** key 停止输入后多久才发请求 —— 否则每敲一个字符都会带着用户的 key 打一次接口 */
const DEBOUNCE_MS = 800;
/** 低于这个长度不认为用户已经输完 key */
const MIN_KEY_LEN = 12;

/** 会话级缓存。只缓存成功结果。 */
const cache = new Map<string, ModelOption[]>();
/**
 * 失败过的 key。**不自动重试** —— 否则粘贴/输入过程中会变成重试风暴。
 * 只有显式 refresh() 才清掉它。
 */
const failed = new Set<string>();

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function normalizeBaseURL(u: string): string {
  return (u ?? "").trim().replace(/\/+$/, "");
}

function isUsableBaseURL(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

interface FetchState {
  fetched: ModelOption[] | null;
  loading: boolean;
  error: string | null;
  warnings: string[];
}

/**
 * 按 provider 拉取模型列表。
 *
 * 三个表单（setup / AddProviderModal / EditProviderForm）共用这一份。
 * 必须**在组件顶层无条件调用**，用 `enabled` 控制是否真的发请求 ——
 * 条件调用 hook 会破坏 hooks 顺序。
 *
 * 几条刻意的行为：
 * - 命中缓存时**同步**给初值，重开表单不会闪一下 loading
 * - 用自增 seq + AbortController 丢弃过期响应，覆盖三个表单各自的竞态
 * - 失败时**绝不**把 fetched 置成 []，也绝不清空用户已保存的列表
 */
export function useProviderModels(params: UseProviderModelsParams): UseProviderModelsResult {
  const { provider, providerType, baseURL, apiKey, enabled } = params;
  const savedModels = React.useMemo(() => params.savedModels ?? [], [params.savedModels]);

  const normalizedBase = normalizeBaseURL(baseURL);
  const trimmedKey = apiKey.trim();
  const cacheKey = `${providerType}|${normalizedBase}|${shortHash(trimmedKey)}`;

  const cacheKeyRef = React.useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const [nonce, setNonce] = React.useState(0);
  const [state, setState] = React.useState<FetchState>(() => ({
    fetched: cache.get(cacheKey) ?? null,
    loading: false,
    error: null,
    warnings: [],
  }));

  const seqRef = React.useRef(0);

  const refresh = React.useCallback(() => {
    failed.delete(cacheKeyRef.current);
    setNonce((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    if (trimmedKey.length < MIN_KEY_LEN) return;
    if (!isUsableBaseURL(normalizedBase)) return;

    const cached = cache.get(cacheKey);
    if (cached) {
      // 同步命中缓存：不闪 loading，也不再发请求
      setState((s) =>
        s.fetched === cached && !s.error ? s : { fetched: cached, loading: false, error: null, warnings: [] }
      );
      return;
    }

    if (failed.has(cacheKey)) return;

    const seq = ++seqRef.current;
    const controller = new AbortController();
    // 手动刷新立即执行，日常输入走防抖
    const delay = nonce > 0 ? 0 : DEBOUNCE_MS;

    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: null }));

      try {
        const res = await fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            provider,
            providerConfig: {
              type: providerType,
              baseURL: normalizedBase,
              apiKey: trimmedKey,
            },
          }),
        });

        const data = (await res.json()) as {
          models?: ModelOption[];
          warnings?: string[];
          error?: string;
        };

        if (seq !== seqRef.current) return; // 已被更新的请求取代，丢弃

        if (!res.ok) {
          failed.add(cacheKey);
          setState((s) => ({
            ...s,
            loading: false,
            error: data.error ?? `请求失败（HTTP ${res.status}）`,
            warnings: data.warnings ?? [],
          }));
          return;
        }

        const models = data.models ?? [];
        cache.set(cacheKey, models);
        failed.delete(cacheKey);

        // 把接口给出的元数据并进 registry，供上下文计量条使用。
        // 注意这**只影响浏览器端**：registry 是模块级单例，服务端另有实例。
        const withMeta = models.filter((m) => m.contextWindow !== undefined || m.maxTokens !== undefined);
        if (withMeta.length > 0) {
          try {
            getDefaultRegistry().register(provider, withMeta);
          } catch {
            /* 注册失败不影响列表展示 */
          }
        }

        setState({ fetched: models, loading: false, error: null, warnings: data.warnings ?? [] });
      } catch (e) {
        if (seq !== seqRef.current) return;
        if ((e as Error)?.name === "AbortError") return;

        failed.add(cacheKey);
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error)?.message ?? "请求失败",
        }));
      }
    }, delay);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cacheKey, enabled, trimmedKey, normalizedBase, provider, providerType, nonce]);

  const available = React.useMemo(
    () => (state.fetched ? state.fetched.map((m) => m.id) : savedModels),
    [state.fetched, savedModels]
  );

  const source: UseProviderModelsResult["source"] = state.fetched
    ? "fetched"
    : savedModels.length > 0
      ? "saved"
      : "none";

  return {
    fetched: state.fetched,
    available,
    source,
    loading: state.loading,
    error: state.error,
    warnings: state.warnings,
    refresh,
  };
}

/** 供测试/登出时清理会话缓存 */
export function clearModelCache(): void {
  cache.clear();
  failed.clear();
}
