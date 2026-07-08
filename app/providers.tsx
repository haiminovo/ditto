"use client";

import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import {
  Config,
  createDefaultConfig,
  isValidConfig,
  Message,
  ModelSet,
} from "@/lib/sdk";

interface AppContextType {
  config: Config;
  isConfigured: boolean;
  saveConfig: (config: Config) => Promise<void>;
  updateProvider: (providerKey: string, providerConfig: any) => Promise<void>;
  setDefaultProvider: (providerKey: string, modelName: string) => Promise<void>;
  deleteProvider: (providerKey: string) => Promise<void>;
  isLoading: boolean;
  sendMessage: (messages: Message[], stream?: boolean) => Promise<{ content: string; stream?: AsyncIterable<string> }>;
  currentModel: { provider: string; model: string } | null;
}

const AppContext = createContext<AppContextType | null>(null);

export function Providers({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Config>(createDefaultConfig());
  const [isLoading, setIsLoading] = useState(true);
  const [modelSet, setModelSet] = useState<ModelSet | null>(null);

  // Initialize config
  useEffect(() => {
    const init = async () => {
      try {
        const stored = localStorage.getItem("ditto:config");
        if (stored) {
          const parsed = JSON.parse(stored);
          setConfig(parsed);
        }
      } catch (e) {
        console.error("Failed to load config:", e);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, []);

  // Initialize model set when config changes
  useEffect(() => {
    if (isValidConfig(config)) {
      try {
        const ms = ModelSet.fromConfig(config);
        setModelSet(ms);
      } catch (error) {
        console.error("Failed to initialize model set:", error);
        setModelSet(null);
      }
    } else {
      setModelSet(null);
    }
  }, [config]);

  const saveConfig = useCallback(async (newConfig: Config) => {
    setConfig(newConfig);
    localStorage.setItem("ditto:config", JSON.stringify(newConfig));
  }, []);

  const updateProvider = useCallback(async (providerKey: string, providerConfig: any) => {
    const newConfig = {
      ...config,
      providers: {
        ...config.providers,
        [providerKey]: providerConfig,
      },
    };
    await saveConfig(newConfig);
  }, [config, saveConfig]);

  const setDefaultProvider = useCallback(async (providerKey: string, modelName: string) => {
    const newConfig = {
      ...config,
      provider: providerKey,
      modelName,
    };
    await saveConfig(newConfig);
  }, [config, saveConfig]);

  const deleteProvider = useCallback(async (providerKey: string) => {
    const newProviders = { ...config.providers };
    delete newProviders[providerKey];

    let newConfig = { ...config, providers: newProviders };

    // If deleted provider was default, switch to another
    if (config.provider === providerKey) {
      const remaining = Object.keys(newProviders).filter(k => newProviders[k].apiKey);
      if (remaining.length > 0) {
        newConfig.provider = remaining[0];
        const firstProvider = newProviders[remaining[0]];
        newConfig.modelName = firstProvider.models?.[0] || "";
      } else {
        newConfig.provider = "";
        newConfig.modelName = "";
      }
    }

    await saveConfig(newConfig);
  }, [config, saveConfig]);

  const sendMessage = useCallback(async (messages: Message[], stream = true) => {
    if (!modelSet) {
      throw new Error("No model configured");
    }

    if (stream) {
      const streamResponse = modelSet.default.generateStream(messages, {
        temperature: 0.7,
      });

      return {
        content: "",
        stream: streamResponse,
      };
    } else {
      const response = await modelSet.default.generate(messages, {
        temperature: 0.7,
      });

      return {
        content: response.content,
      };
    }
  }, [modelSet]);

  const currentModel = isValidConfig(config)
    ? { provider: config.provider, model: config.modelName }
    : null;

  return (
    <AppContext.Provider
      value={{
        config,
        isConfigured: isValidConfig(config),
        saveConfig,
        updateProvider,
        setDefaultProvider,
        deleteProvider,
        isLoading,
        sendMessage,
        currentModel,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within Providers");
  }
  return context;
}
