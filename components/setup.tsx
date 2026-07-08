"use client";

import { useState } from "react";
import { useApp } from "@/app/providers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROVIDERS,
  ProviderKey,
  getProviderName,
} from "@/lib/sdk";
import { ArrowLeft, Check, Settings, Plus, Trash2, Eye, EyeOff } from "lucide-react";

export function SetupPage() {
  const [step, setStep] = useState<"welcome" | "provider" | "config" | "success">("welcome");
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey | "custom" | null>(null);
  const [providerName, setProviderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseURL, setBaseURL] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [providerType, setProviderType] = useState<"anthropic" | "openai">("openai");
  const [isSaving, setIsSaving] = useState(false);
  const { saveConfig, config } = useApp();

  const handleProviderSelect = (provider: ProviderKey | "custom") => {
    setSelectedProvider(provider);
    if (provider === "custom") {
      setProviderName("");
      setBaseURL("");
      setModels([]);
      setSelectedModel("");
      setProviderType("openai");
    } else {
      setProviderName(PROVIDERS[provider].name);
      setBaseURL(PROVIDERS[provider].baseURL);
      setModels([...PROVIDERS[provider].models]);
      setSelectedModel(PROVIDERS[provider].models[0]);
      setProviderType(PROVIDERS[provider].type as any);
    }
    setStep("config");
  };

  const addModel = () => {
    if (modelInput.trim() && !models.includes(modelInput.trim())) {
      setModels([...models, modelInput.trim()]);
      if (models.length === 0) {
        setSelectedModel(modelInput.trim());
      }
      setModelInput("");
    }
  };

  const removeModel = (model: string) => {
    const newModels = models.filter((m) => m !== model);
    setModels(newModels);
    if (selectedModel === model) {
      setSelectedModel(newModels.length > 0 ? newModels[0] : "");
    }
  };

  const handleSave = async () => {
    const providerKey = selectedProvider === "custom" ? `custom_${Date.now()}` : selectedProvider;
    if (!providerKey) return;

    setIsSaving(true);
    try {
      const providerConfig = config.providers[providerKey] || {};
      // 对于预定义的 provider，确保 type 正确设置
      const actualProviderType = selectedProvider && selectedProvider !== "custom" && selectedProvider in PROVIDERS
        ? PROVIDERS[selectedProvider as keyof typeof PROVIDERS].type
        : providerType;

      const newConfig = {
        ...config,
        provider: providerKey,
        modelName: selectedModel,
        providers: {
          ...config.providers,
          [providerKey]: {
            ...providerConfig,
            type: actualProviderType,
            name: selectedProvider === "custom" ? providerName : undefined,
            apiKey,
            baseURL: baseURL || undefined,
            models: models.length > 0 ? models : undefined,
          },
        },
      };

      console.log("Saving config:", newConfig);
      await saveConfig(newConfig);
      setStep("success");
    } catch (error) {
      console.error("Failed to save config:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        {step === "welcome" && (
          <>
            <CardHeader className="text-center">
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-4">
                <Settings className="w-8 h-8 text-blue-600 dark:text-blue-400" />
              </div>
              <CardTitle className="text-3xl">欢迎使用 Ditto</CardTitle>
              <CardDescription className="text-lg mt-2">
                多 Provider LLM 客户端 - 支持 OpenAI、Anthropic 等
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <Button size="lg" onClick={() => setStep("provider")}>
                开始设置
              </Button>
            </CardContent>
          </>
        )}

        {step === "provider" && (
          <>
            <CardHeader>
              <div className="flex items-center mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep("welcome")}
                  className="mr-2"
                >
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  返回
                </Button>
              </div>
              <CardTitle>选择 Provider</CardTitle>
              <CardDescription>选择你想使用的 AI 提供商</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(Object.entries(PROVIDERS) as [ProviderKey, typeof PROVIDERS[ProviderKey]][]).map(
                  ([key, provider]) => (
                    <button
                      key={key}
                      onClick={() => handleProviderSelect(key)}
                      className="text-left p-4 rounded-lg border border-gray-200 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <div className="font-medium">{provider.name}</div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {key === "custom" ? "自定义配置" : `${provider.models.length} 个可用模型`}
                      </div>
                    </button>
                  )
                )}
              </div>
            </CardContent>
          </>
        )}

        {step === "config" && selectedProvider && (
          <>
            <CardHeader>
              <div className="flex items-center mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep("provider")}
                  className="mr-2"
                >
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  返回
                </Button>
              </div>
              <CardTitle>
                配置 {selectedProvider === "custom" ? "自定义 Provider" : getProviderName(selectedProvider, config)}
              </CardTitle>
              <CardDescription>输入您的 API Key 和其他设置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selectedProvider === "custom" && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-2">Provider 名称</label>
                    <Input
                      value={providerName}
                      onChange={(e) => setProviderName(e.target.value)}
                      placeholder="例如：我的私有 API"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">API 类型</label>
                    <select
                      value={providerType}
                      onChange={(e) => setProviderType(e.target.value as "anthropic" | "openai")}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-950 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="openai">OpenAI 兼容模式</option>
                      <option value="anthropic">Anthropic 原生模式</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">API Key</label>
                <div className="relative">
                  <Input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="输入 API Key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Base URL</label>
                <Input
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder={selectedProvider !== "custom" ? PROVIDERS[selectedProvider as ProviderKey].baseURL : "例如：https://api.example.com/v1"}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">
                  模型列表
                  <span className="text-gray-400 font-normal ml-1">（每行一个）</span>
                </label>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={modelInput}
                      onChange={(e) => setModelInput(e.target.value)}
                      placeholder="输入模型名称，按回车添加"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModel();
                        }
                      }}
                    />
                    <Button variant="secondary" onClick={addModel}>
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {models.map((model) => (
                      <span
                        key={model}
                        className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-sm"
                      >
                        {model}
                        <button
                          onClick={() => removeModel(model)}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">选择默认模型</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="flex h-10 w-full items-center justify-between rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {models.length === 0 && (
                    <option value="">请先添加模型</option>
                  )}
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                className="w-full"
                size="lg"
                onClick={handleSave}
                disabled={!apiKey || !selectedModel || isSaving}
              >
                {isSaving ? "保存中..." : "保存配置"}
              </Button>
            </CardContent>
          </>
        )}

        {step === "success" && (
          <CardContent className="text-center py-8">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <CardTitle className="text-2xl mb-2">配置完成！</CardTitle>
            <CardDescription>您现在可以开始使用 Ditto 了</CardDescription>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
