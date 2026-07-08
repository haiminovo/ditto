"use client";

import { useState, useRef, useEffect } from "react";
import { useApp } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  MessageSquare,
  Plus,
  Settings,
  Send,
  Bot,
  User,
  Trash2,
  Pencil,
  Image as ImageIcon,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  Message as DittoMessage,
  PROVIDERS,
  ProviderKey,
  getProviderName,
  getProviderBaseURL,
  getProviderModels,
  getDefaultRegistry,
  estimateMessagesTokens,
} from "@/lib/sdk";
import { cn } from "@/components/ui/button";

interface ChatImage {
  id: string;
  url: string;
  mimeType?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  images?: ChatImage[];
  isStreaming?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

export function ChatPage() {
  const [currentSessionId, setCurrentSessionId] = useState<string>("default");
  const [sessions, setSessions] = useState<Map<string, ChatSession>>(new Map([
    ["default", { id: "default", title: "新对话", messages: [], createdAt: Date.now() }],
  ]));
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { sendMessage, currentModel, config, saveConfig, updateProvider, deleteProvider, isConfigured } = useApp();

  const currentSession = sessions.get(currentSessionId) || sessions.get("default")!;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentSession.messages]);

  const createNewSession = () => {
    const id = Date.now().toString();
    const newSession: ChatSession = {
      id,
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
    };
    setSessions(new Map(sessions).set(id, newSession));
    setCurrentSessionId(id);
  };

  const updateSession = (id: string, update: Partial<ChatSession> | ((prev: Map<string, ChatSession>) => Map<string, ChatSession>)) => {
    if (typeof update === "function") {
      setSessions(update);
    } else {
      const session = sessions.get(id);
      if (session) {
        setSessions(new Map(sessions).set(id, { ...session, ...update }));
      }
    }
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.size <= 1) return;
    const newSessions = new Map(sessions);
    newSessions.delete(id);
    setSessions(newSessions);
    if (currentSessionId === id) {
      setCurrentSessionId(newSessions.keys().next().value);
    }
  };

  // 图片压缩函数
  const compressImage = async (file: File): Promise<{ url: string, mimeType: string }> => {
    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };

      img.onload = () => {
        // 创建 canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;

        // [Step 1 & 2] 限制长边尺寸（最大 2048px）
        const maxDimension = 2048;
        let { width, height } = img;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;

        // [Step 3] 绘制并统一色彩空间
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        // [Step 4] WebP 压缩 (0.8 quality)，fallback to JPEG
        let mimeType = 'image/webp';
        let quality = 0.8;
        let compressedUrl = canvas.toDataURL(mimeType, quality);

        // 如果 WebP 不支持，使用 JPEG
        if (!compressedUrl.startsWith('data:image/webp')) {
          mimeType = 'image/jpeg';
          quality = 0.85;
          compressedUrl = canvas.toDataURL(mimeType, quality);
        }

        // 如果压缩后比原图还大，尝试降低质量
        if (compressedUrl.length > (file.size * 1.5)) {
          mimeType = 'image/jpeg';
          quality = 0.7;
          compressedUrl = canvas.toDataURL(mimeType, quality);
        }

        resolve({ url: compressedUrl, mimeType });
      };

      reader.readAsDataURL(file);
    });
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(async (file) => {
      const { url, mimeType } = await compressImage(file);
      setPendingImages(prev => [...prev, {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        url,
        mimeType
      }]);
    });
    // Clear input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removePendingImage = (imageId: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== imageId));
  };

  const handleSend = async () => {
    if ((!input.trim() && pendingImages.length === 0) || isStreaming) return;

    const userMessageId = Date.now().toString();
    const assistantMessageId = (Date.now() + 1).toString();

    const newUserMessage: ChatMessage = {
      id: userMessageId,
      role: "user",
      content: input.trim(),
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
    };

    // 获取当前会话的最新状态
    const currentSessionLatest = sessions.get(currentSessionId) || sessions.get("default")!;
    const isFirstMessage = currentSessionLatest.messages.length === 0;

    const updatedMessages = [...currentSessionLatest.messages, newUserMessage];
    const messagesWithAssistantPlaceholder = [
      ...updatedMessages,
      { id: assistantMessageId, role: "assistant", content: "", isStreaming: true } as ChatMessage,
    ];

    // 一次性更新：添加用户消息和助手占位符
    updateSession(currentSessionId, { messages: messagesWithAssistantPlaceholder });
    setInput("");
    setPendingImages([]);
    setIsStreaming(true);

    try {
      const messagesForApi: DittoMessage[] = updatedMessages.map((m) => {
        // 如果是用户消息且有图片，构建多模态内容
        if (m.role === "user" && m.images && m.images.length > 0) {
          const content: any[] = [];
          if (m.content) {
            content.push({ type: "text", text: m.content });
          }
          m.images.forEach(img => {
            content.push({ type: "image_url", image_url: { url: img.url } });
          });
          return { role: m.role, content };
        }
        return { role: m.role, content: m.content };
      });

      const { stream } = await sendMessage(messagesForApi, true);

      if (stream) {
        let fullContent = "";
        for await (const chunk of stream) {
          fullContent += chunk;
          // 获取最新状态更新
          updateSession(currentSessionId, (prevSessions) => {
            const currentSession = prevSessions.get(currentSessionId);
            if (!currentSession) return prevSessions;

            const newMessages = [...currentSession.messages];
            const assistantMsgIndex = newMessages.findIndex(m => m.id === assistantMessageId);

            if (assistantMsgIndex >= 0) {
              newMessages[assistantMsgIndex] = {
                ...newMessages[assistantMsgIndex],
                content: fullContent,
              };
            }

            return new Map(prevSessions).set(currentSessionId, {
              ...currentSession,
              messages: newMessages,
            });
          });
        }

        // 最终更新
        updateSession(currentSessionId, (prevSessions) => {
          const currentSession = prevSessions.get(currentSessionId);
          if (!currentSession) return prevSessions;

          const finalMessages = [...currentSession.messages];
          const assistantMsgIndex = finalMessages.findIndex(m => m.id === assistantMessageId);

          if (assistantMsgIndex >= 0) {
            finalMessages[assistantMsgIndex] = {
              ...finalMessages[assistantMsgIndex],
              isStreaming: false,
            };
          }

          const update: Partial<ChatSession> = { messages: finalMessages };

          // 如果是第一条消息，设置标题
          if (isFirstMessage) {
            update.title = fullContent.slice(0, 30) + (fullContent.length > 30 ? "..." : "");
          }

          return new Map(prevSessions).set(currentSessionId, {
            ...currentSession,
            ...update,
          });
        });
      }
    } catch (error) {
      console.error("Failed to send message:", error);
      updateSession(currentSessionId, {
        messages: [
          ...updatedMessages,
          {
            id: assistantMessageId,
            role: "assistant",
            content: `错误: ${(error as Error).message}`,
            isStreaming: false,
          },
        ],
      });
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      <div className="w-64 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="p-4">
          <Button
            className="w-full justify-start gap-2"
            variant="secondary"
            onClick={createNewSession}
          >
            <Plus className="w-4 h-4" />
            新对话
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {Array.from(sessions.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((session) => (
              <div
                key={session.id}
                onClick={() => setCurrentSessionId(session.id)}
                className={cn(
                  "group relative flex items-center p-3 rounded-md cursor-pointer transition-colors",
                  session.id === currentSessionId
                    ? "bg-gray-100 dark:bg-gray-800"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
                )}
              >
                <MessageSquare className="w-4 h-4 mr-3 text-gray-400" />
                <span className="flex-1 text-sm truncate">{session.title}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 group-hover:opacity-100 -mr-2 h-7 w-7 p-0"
                  onClick={(e) => deleteSession(session.id, e)}
                >
                  <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
            ))}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-800">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="w-4 h-4" />
            设置
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="border-b border-gray-200 dark:border-gray-800 p-4">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="font-semibold text-lg">{currentSession.title}</h1>
                {currentModel && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {currentModel.provider} / {currentModel.model}
                  </p>
                )}
              </div>
              {currentSession.messages.length > 0 && (() => {
                const registry = getDefaultRegistry();
                const modelEntry = currentModel ? registry.resolve(currentModel.model) : null;
                const estimatedTokens = Math.max(0, estimateMessagesTokens(currentSession.messages));
                const maxContext = modelEntry?.contextWindow ?? 128000;
                const usagePercent = Math.max(0, Math.min((estimatedTokens / maxContext) * 100, 100));

                return (
                  <div className="text-right">
                    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      ~{Math.max(0, estimatedTokens).toLocaleString()} / {maxContext.toLocaleString()} tokens
                    </div>
                    <div className="w-32 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${usagePercent > 80 ? "bg-red-500" : usagePercent > 50 ? "bg-yellow-500" : "bg-blue-500"}`}
                        style={{ width: `${Math.max(0, Math.min(usagePercent, 100))}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto py-8">
            {currentSession.messages.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Bot className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
                <h2 className="text-xl font-semibold mb-2">开始对话</h2>
                <p className="text-gray-500 dark:text-gray-400">
                  输入消息开始与 AI 对话
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {currentSession.messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "flex gap-4 px-4",
                      message.role === "user" ? "flex-row-reverse" : ""
                    )}
                  >
                    <div
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                        message.role === "user"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                      )}
                    >
                      {message.role === "user" ? (
                        <User className="w-5 h-5" />
                      ) : (
                        <Bot className="w-5 h-5" />
                      )}
                    </div>
                    <div
                      className={cn(
                        "flex-1 max-w-[80%]",
                        message.role === "user" && "text-right"
                      )}
                    >
                      <div
                        className={cn(
                          "inline-block text-left rounded-lg px-4 py-3",
                          message.role === "user"
                            ? "bg-blue-600 text-white"
                            : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
                        )}
                      >
                        {message.images && message.images.length > 0 && (
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            {message.images.map((img) => (
                              <img
                                key={img.id}
                                src={img.url}
                                alt="Uploaded image"
                                className="max-h-48 max-w-full object-contain rounded"
                              />
                            ))}
                          </div>
                        )}
                        {message.role === "assistant" ? (
                          <div className="prose dark:prose-invert prose-sm max-w-none">
                            <ReactMarkdown>{message.content}</ReactMarkdown>
                            {message.isStreaming && (
                              <span className="inline-block w-2 h-4 bg-gray-400 dark:bg-gray-500 ml-1 animate-pulse" />
                            )}
                          </div>
                        ) : (
                          message.content && <div className="whitespace-pre-wrap">{message.content}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-800 p-4">
          <div className="max-w-3xl mx-auto">
            {/* 待上传图片预览 */}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pendingImages.map((img) => (
                  <div key={img.id} className="relative">
                    <img
                      src={img.url}
                      alt="Pending upload"
                      className="h-20 w-20 object-cover rounded"
                    />
                    <button
                      onClick={() => removePendingImage(img.id)}
                      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={async (e) => {
                  const items = e.clipboardData.items;
                  for (const item of items) {
                    if (item.type.startsWith("image/")) {
                      const file = item.getAsFile();
                      if (file) {
                        const { url, mimeType } = await compressImage(file);
                        setPendingImages(prev => [...prev, {
                          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                          url,
                          mimeType
                        }]);
                      }
                    }
                  }
                }}
                placeholder="输入消息或粘贴图片... (Enter 发送, Shift+Enter 换行)"
                className="resize-none pl-12 pr-12 min-h-[60px] max-h-[200px]"
                rows={1}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImageSelect}
              />
              <Button
                variant="ghost"
                size="sm"
                className="absolute left-2 bottom-2"
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming}
              >
                <ImageIcon className="w-4 h-4" />
              </Button>
              <Button
                className="absolute right-2 bottom-2"
                size="sm"
                onClick={handleSend}
                disabled={(!input.trim() && pendingImages.length === 0) || isStreaming}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          config={config}
          saveConfig={saveConfig}
          updateProvider={updateProvider}
          deleteProvider={deleteProvider}
          isConfigured={isConfigured}
        />
      )}
    </div>
  );
}

function SettingsModal({
  onClose,
  config,
  saveConfig,
  updateProvider,
  deleteProvider,
  isConfigured,
}: {
  onClose: () => void;
  config: any;
  saveConfig: (config: any) => Promise<void>;
  updateProvider: (key: string, config: any) => Promise<void>;
  deleteProvider: (key: string) => Promise<void>;
  isConfigured: boolean;
}) {
  const [activeTab, setActiveTab] = useState<"providers" | "models">("providers");
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-2xl max-h-[80vh] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle>设置</CardTitle>
            <CardDescription>管理您的 providers 和模型配置</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </CardHeader>

        <div className="px-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex gap-4">
            <button
              onClick={() => setActiveTab("providers")}
              className={cn(
                "py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === "providers"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              )}
            >
              Providers
            </button>
          </div>
        </div>

        <CardContent className="flex-1 overflow-y-auto pt-6">
          {activeTab === "providers" && (
            <ProvidersTab
              config={config}
              onUpdateProvider={updateProvider}
              onSaveConfig={saveConfig}
              onDeleteProvider={deleteProvider}
              onClose={onClose}
              setAddProviderOpen={setAddProviderOpen}
              addProviderOpen={addProviderOpen}
              editingProvider={editingProvider}
              setEditingProvider={setEditingProvider}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProvidersTab({
  config,
  onUpdateProvider,
  onSaveConfig,
  onDeleteProvider,
  onClose,
  setAddProviderOpen,
  addProviderOpen,
  editingProvider,
  setEditingProvider,
}: {
  config: any;
  onUpdateProvider: (key: string, config: any) => Promise<void>;
  onSaveConfig: (config: any) => Promise<void>;
  onDeleteProvider: (key: string) => Promise<void>;
  onClose: () => void;
  setAddProviderOpen: (v: boolean) => void;
  addProviderOpen: boolean;
  editingProvider: string | null;
  setEditingProvider: (v: string | null) => void;
}) {
  return (
    <div className="space-y-6">
      {config.provider && config.modelName && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <div className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-1">
            当前默认
          </div>
          <div className="text-blue-900 dark:text-blue-200">
            {getProviderName(config.provider, config)} / {config.modelName}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-medium">已配置的 Providers</h3>
          <Button size="sm" onClick={() => setAddProviderOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            添加
          </Button>
        </div>

        {Object.keys(config.providers).length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            暂无已配置的 provider
          </div>
        ) : (
          <div className="space-y-2">
            {(Object.entries(config.providers) as [string, any][]).map(
              ([key, providerConfig]) => {
                return (
                  <div
                    key={key}
                    className="p-4 rounded-lg border border-gray-200 dark:border-gray-800"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-medium">
                          {getProviderName(key, config)}
                          {config.provider === key && (
                            <span className="ml-2 text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                              默认
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          {providerConfig.apiKey ? "已配置 API Key" : "未配置"}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingProvider(key)}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDeleteProvider(key)}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </div>

                    {editingProvider === key && (
                      <EditProviderForm
                        providerKey={key}
                        existingConfig={providerConfig}
                        isDefault={config.provider === key}
                        onSave={async (newConfig) => {
                          await onUpdateProvider(key, newConfig);
                          setEditingProvider(null);
                        }}
                        onSetDefault={async (modelName) => {
                          const newConfig = {
                            ...config,
                            provider: key,
                            modelName,
                          };
                          await onSaveConfig(newConfig);
                          setEditingProvider(null);
                        }}
                        onCancel={() => setEditingProvider(null)}
                        config={config}
                      />
                    )}
                  </div>
                );
              }
            )}
          </div>
        )}
      </div>

      {addProviderOpen && (
        <AddProviderModal
          config={config}
          onAdd={async (providerKey, providerConfig, modelName) => {
            const newConfig = {
              ...config,
              providers: {
                ...config.providers,
                [providerKey]: providerConfig,
              },
              provider: Object.keys(config.providers).length === 0 ? providerKey : config.provider,
              modelName: Object.keys(config.providers).length === 0 ? modelName : config.modelName,
            };
            await onSaveConfig(newConfig);
            setAddProviderOpen(false);
          }}
          onCancel={() => {
            setAddProviderOpen(false);
          }}
        />
      )}
    </div>
  );
}

function EditProviderForm({
  providerKey,
  existingConfig,
  isDefault,
  onSave,
  onSetDefault,
  onCancel,
  config,
}: {
  providerKey: string;
  existingConfig: any;
  isDefault: boolean;
  onSave: (config: any) => Promise<void>;
  onSetDefault: (modelName: string) => Promise<void>;
  onCancel: () => void;
  config: any;
}) {
  const [name, setName] = useState(existingConfig.name || "");
  const [apiKey, setApiKey] = useState(existingConfig.apiKey || "");
  const [baseURL, setBaseURL] = useState(existingConfig.baseURL || getProviderBaseURL(providerKey, config));
  const [models, setModels] = useState<string[]>(existingConfig.models || getProviderModels(providerKey, config));
  const [modelInput, setModelInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const addModel = () => {
    if (modelInput.trim() && !models.includes(modelInput.trim())) {
      setModels([...models, modelInput.trim()]);
      setModelInput("");
    }
  };

  const removeModel = (model: string) => {
    setModels(models.filter((m) => m !== model));
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-4">
      {providerKey.startsWith("custom_") && (
        <div>
          <label className="block text-sm font-medium mb-2">Provider 名称</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}
      <div>
        <label className="block text-sm font-medium mb-2">API Key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Base URL (可选)</label>
        <Input
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
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

      {!isDefault && models.length > 0 && (
        <div>
          <label className="block text-sm font-medium mb-2">选择默认模型</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="flex h-10 w-full items-center justify-between rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">选择模型...</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        {!isDefault && selectedModel && (
          <Button variant="secondary" onClick={() => onSetDefault(selectedModel)}>
            设为默认
          </Button>
        )}
        <Button onClick={() => {
          // 确保保存时保留或设置正确的 type
          let providerType = existingConfig.type;
          if (!providerType && providerKey in PROVIDERS) {
            providerType = (PROVIDERS as any)[providerKey].type;
          }
          onSave({ ...existingConfig, type: providerType, name, apiKey, baseURL, models });
        }}>
          保存
        </Button>
      </div>
    </div>
  );
}

function AddProviderModal({
  config,
  onAdd,
  onCancel,
}: {
  config: any;
  onAdd: (providerKey: string, config: any, modelName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"select" | "config">("select");
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey | "custom" | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerType, setProviderType] = useState<"anthropic" | "openai">("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const handleSelectProvider = (provider: ProviderKey | "custom") => {
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
      setModelInput("");
    }
  };

  const removeModel = (model: string) => {
    setModels(models.filter((m) => m !== model));
    if (selectedModel === model) {
      setSelectedModel(models.length > 1 ? models[0] : "");
    }
  };

  if (step === "select") {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-60 p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>添加 Provider</CardTitle>
            <CardDescription>选择要添加的 provider</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(PROVIDERS) as [ProviderKey, typeof PROVIDERS[ProviderKey]][]).map(
                ([key, provider]) => (
                  <button
                    key={key}
                    onClick={() => handleSelectProvider(key)}
                    className="text-left p-4 rounded-lg border border-gray-200 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <div className="font-medium">{provider.name}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {key === "custom" ? "完全自定义配置" : `${provider.models.length} 个预设模型`}
                    </div>
                  </button>
                )
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <Button variant="ghost" onClick={onCancel}>取消</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-60 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            配置 {selectedProvider === "custom" ? "自定义 Provider" : getProviderName(selectedProvider as ProviderKey, config)}
          </CardTitle>
          <CardDescription>输入 API Key 和其他设置</CardDescription>
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
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入 API Key"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Base URL {selectedProvider !== "custom" && <span className="text-gray-400 font-normal">（可选）</span>}
            </label>
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
              {models.length === 0 && <option value="">请先添加模型</option>}
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2 justify-end pt-4">
            <Button variant="ghost" onClick={() => setStep("select")}>
              上一步
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              disabled={!apiKey || !selectedModel}
              onClick={() => {
                if (!selectedProvider) return;
                const providerKey = selectedProvider === "custom" ? `custom_${Date.now()}` : selectedProvider;
                // 对于预定义的 provider，使用正确的 type
                const actualProviderType = selectedProvider !== "custom" && selectedProvider in PROVIDERS
                  ? (PROVIDERS as any)[selectedProvider].type
                  : providerType;
                onAdd(
                  providerKey,
                  {
                    type: actualProviderType,
                    name: selectedProvider === "custom" ? providerName : undefined,
                    apiKey,
                    baseURL: baseURL || undefined,
                    models: models.length > 0 ? models : undefined,
                  },
                  selectedModel
                );
              }}
            >
              添加
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
