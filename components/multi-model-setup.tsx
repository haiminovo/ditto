"use client";

import { useMemo, useState } from "react";
import { MessagesSquare, Play, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  getProviderName,
  type Config,
  type MultiModelConfig,
  type MultiModelParticipant,
} from "@/lib/sdk";

interface ParticipantDraft {
  key: string;
  modelValue: string;
  role: string;
  instructions: string;
}

function optionValue(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function modelFromValue(
  value: string,
  config: Config
): { provider: string; model: string; label: string } | null {
  const separator = value.indexOf("::");
  if (separator < 1) return null;
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 2);
  return {
    provider,
    model,
    label: `${getProviderName(provider, config)} / ${model}`,
  };
}

function newDraft(modelValue: string, role: string, key?: string): ParticipantDraft {
  return {
    key: key ?? `participant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    modelValue,
    role,
    instructions: "",
  };
}

export function MultiModelSetup({
  config,
  initial,
  onStart,
  onClose,
}: {
  config: Config;
  initial?: MultiModelConfig;
  onStart: (config: MultiModelConfig, prompt: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      if (!providerConfig.apiKey) continue;
      const models =
        providerConfig.models && providerConfig.models.length > 0
          ? providerConfig.models
          : config.provider === provider && config.modelName
            ? [config.modelName]
            : [];
      for (const model of models) {
        out.push({
          value: optionValue(provider, model),
          label: `${getProviderName(provider, config)} / ${model}`,
        });
      }
    }
    return out;
  }, [config]);

  const initialDrafts = initial
    ? initial.participants
        .map((participant) => {
          const value = optionValue(participant.provider, participant.model);
          if (!options.some((option) => option.value === value)) return null;
          return {
            key: participant.id,
            modelValue: value,
            role: participant.role ?? "",
            instructions: participant.systemPrompt ?? "",
          } satisfies ParticipantDraft;
        })
        .filter((draft): draft is ParticipantDraft => draft !== null)
    : [];

  const defaultCount =
    options.length === 0 ? 0 : Math.min(Math.max(options.length, 2), 3);
  const defaultDrafts = Array.from({ length: defaultCount }, (_, index) =>
    newDraft(
      options[index % options.length].value,
      `参与者 ${index + 1}`
    )
  );

  const [participants, setParticipants] = useState(
    initialDrafts.length >= 2 ? initialDrafts : defaultDrafts
  );
  const [maxTurns, setMaxTurns] = useState(String(initial?.maxTurns ?? 6));
  const [prompt, setPrompt] = useState("");
  const canStart =
    options.length >= 1 &&
    participants.length >= 2 &&
    participants.every(
      (participant) =>
        participant.modelValue !== "" &&
        options.some((option) => option.value === participant.modelValue)
    ) &&
    prompt.trim() !== "";

  const updateParticipant = (
    key: string,
    patch: Partial<Omit<ParticipantDraft, "key">>
  ) => {
    setParticipants((current) =>
      current.map((participant) =>
        participant.key === key ? { ...participant, ...patch } : participant
      )
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="max-h-[88vh] w-full max-w-2xl overflow-y-auto">
        <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessagesSquare className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              多模型讨论
            </CardTitle>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              模型可指定下一位发言者，未指定时按参与者顺序轮转
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-5 pt-2">
          {options.length < 1 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              至少需要配置一个可用模型，并添加两个参与者。
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">参与模型与角色</label>
              <Button
                variant="ghost"
                size="sm"
                disabled={options.length === 0}
                onClick={() =>
                  setParticipants((current) => [
                    ...current,
                    newDraft(
                      options[0]?.value ?? "",
                      `参与者 ${current.length + 1}`
                    ),
                  ])
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                添加参与者
              </Button>
            </div>

            {participants.map((participant, index) => (
              <div
                key={participant.key}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
              >
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-center text-xs text-gray-400">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Select
                      value={participant.modelValue}
                      onChange={(value) =>
                        updateParticipant(participant.key, { modelValue: value })
                      }
                      options={options}
                      placeholder="选择模型"
                      aria-label={`参与模型 ${index + 1}`}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`移除参与者 ${index + 1}`}
                    disabled={participants.length <= 2}
                    onClick={() =>
                      setParticipants((current) =>
                        current.filter((item) => item.key !== participant.key)
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                  </Button>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={participant.role}
                    onChange={(event) =>
                      updateParticipant(participant.key, {
                        role: event.target.value,
                      })
                    }
                    placeholder="角色，例如：正方、反方、主持人"
                    aria-label={`参与者 ${index + 1} 角色`}
                  />
                  <Input
                    value={participant.instructions}
                    onChange={(event) =>
                      updateParticipant(participant.key, {
                        instructions: event.target.value,
                      })
                    }
                    placeholder="角色说明（可选）"
                    aria-label={`参与者 ${index + 1} 角色说明`}
                  />
                </div>
              </div>
            ))}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">最大发言次数</label>
            <Select
              value={maxTurns}
              onChange={setMaxTurns}
              options={[2, 4, 6, 8, 12, 16, 20, 30].map((value) => ({
                value: String(value),
                label: `${value} 次模型发言`,
              }))}
              aria-label="最大发言次数"
            />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              模型可以根据讨论进展指定下一位；达到次数后自动停止。
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium">讨论主题</label>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="例如：讨论这个实施方案的风险，并逐项提出改进建议"
            />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              自动讨论期间不启用工具，避免多个模型并发执行写操作。
            </p>
          </div>

          <Button
            className="w-full"
            disabled={!canStart}
            onClick={() => {
              const selected: MultiModelParticipant[] = [];
              participants.forEach((participant, index) => {
                const model = modelFromValue(participant.modelValue, config);
                if (!model) return;
                const role = participant.role.trim() || `参与者 ${index + 1}`;
                selected.push({
                  id: `participant_${index + 1}`,
                  provider: model.provider,
                  model: model.model,
                  name: `${model.label} · ${role}`,
                  role,
                  systemPrompt: participant.instructions.trim() || undefined,
                });
              });
              if (selected.length < 2) return;
              onStart(
                {
                  participants: selected,
                  maxTurns: Number(maxTurns),
                },
                prompt.trim()
              );
            }}
          >
            <Play className="mr-2 h-4 w-4" />
            开始讨论
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
