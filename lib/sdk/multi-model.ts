import type { Message } from "./types";

export interface MultiModelParticipant {
  /** 参与者实例 id，与具体模型解耦，允许同一模型出现多次。 */
  id: string;
  provider: string;
  model: string;
  /** 展示名，例如「GPT-4o · 正方」。 */
  name: string;
  /** 简短角色名，例如正方、反方、主持人。 */
  role?: string;
  /** 该参与者的额外角色说明。 */
  systemPrompt?: string;
}

export interface MultiModelConfig {
  participants: MultiModelParticipant[];
  maxTurns: number;
}

export interface MultiModelEntry {
  role: "user" | "assistant";
  content: string;
  participantId?: string;
  channel?: "public" | "private";
  recipientId?: string;
}

export interface MultiModelSelectionContext {
  selectedBy?: MultiModelParticipant;
  reason?: string;
}

export interface MultiModelNextSpeaker {
  content: string;
  nextParticipant?: MultiModelParticipant;
  nextUser?: boolean;
  reason?: string;
  privateMessages?: MultiModelPrivateMessage[];
}

export interface MultiModelPrivateMessage {
  recipient: MultiModelParticipant;
  content: string;
  topic?: string;
}

export function multiModelParticipantId(
  participant: MultiModelParticipant
): string {
  return participant.id;
}

export function multiModelParticipantAt(
  config: MultiModelConfig,
  turn: number
): MultiModelParticipant {
  if (config.participants.length === 0) {
    throw new Error("多模型讨论至少需要一个参与者");
  }
  return config.participants[turn % config.participants.length];
}

export function nextMultiModelParticipant(
  config: MultiModelConfig,
  currentParticipantId: string
): MultiModelParticipant {
  if (config.participants.length === 0) {
    throw new Error("多模型讨论至少需要一个参与者");
  }
  const currentIndex = config.participants.findIndex(
    (participant) => participant.id === currentParticipantId
  );
  const nextIndex =
    currentIndex >= 0 ? (currentIndex + 1) % config.participants.length : 0;
  return config.participants[nextIndex];
}

const NEXT_SPEAKER_RE =
  /\[\[(?:next_speaker|next|下一位)\s*:\s*([^|\]]+?)(?:\s*\|\s*(?:reason|理由)\s*:\s*([^\]]+?))?\s*\]\]/i;
const PRIVATE_MESSAGE_RE =
  /\[\[private\s*:\s*([^|\]]+?)(?:\s*\|\s*(?:topic|主题)\s*:\s*([^\]]+?))?\s*\]\]([\s\S]*?)\[\[\/private\]\]/gi;

function privateMessageBlocks(raw: string): {
  content: string;
  messages: Array<{ recipientToken: string; topic?: string; content: string }>;
} {
  const messages: Array<{
    recipientToken: string;
    topic?: string;
    content: string;
  }> = [];
  const content = raw.replace(
    new RegExp(PRIVATE_MESSAGE_RE.source, "gi"),
    (_match, recipientToken: string, topic: string | undefined, body: string) => {
      messages.push({
        recipientToken: recipientToken.trim(),
        topic: topic?.trim() || undefined,
        content: body.trim(),
      });
      return "";
    }
  );
  return { content, messages };
}

/**
 * 解析模型回复末尾的隐藏调度指令。
 *
 * 指令不会展示给用户，也不会写入讨论记录；它只决定下一次由谁发言。
 */
export function parseMultiModelNextSpeaker(
  raw: string,
  config: MultiModelConfig,
  currentParticipantId: string
): MultiModelNextSpeaker {
  const parsedPrivate = privateMessageBlocks(raw);
  const privateMessages: MultiModelPrivateMessage[] = [];
  for (const message of parsedPrivate.messages) {
    const recipient = config.participants.find((participant) => {
      const values = [
        participant.id,
        participant.name,
        participant.role ?? "",
        `${participant.provider}/${participant.model}`,
      ].map((value) => value.trim().toLowerCase());
      return values.includes(message.recipientToken.toLowerCase());
    });
    if (recipient && message.content) {
      privateMessages.push({
        recipient,
        content: message.content,
        topic: message.topic,
      });
    }
  }

  const matches = [
    ...parsedPrivate.content.matchAll(new RegExp(NEXT_SPEAKER_RE.source, "gi")),
  ];
  const match = matches.at(-1);
  const content = parsedPrivate.content
    .replace(new RegExp(NEXT_SPEAKER_RE.source, "gi"), "")
    .trim();

  if (!match) return { content, privateMessages };

  const token = match[1].trim().replace(/^["'「]|["'」]$/g, "").toLowerCase();
  const userTokens = new Set([
    "user",
    "human",
    "participant_user",
    "用户",
    "人类",
    "你",
  ]);
  if (userTokens.has(token)) {
    return {
      content,
      nextUser: true,
      reason: match[2]?.trim() || undefined,
      privateMessages,
    };
  }

  const candidates = config.participants.filter(
    (participant) => participant.id !== currentParticipantId
  );
  const nextParticipant = candidates.find((participant) => {
    const values = [
      participant.id,
      participant.name,
      participant.role ?? "",
      `${participant.provider}/${participant.model}`,
    ].map((value) => value.trim().toLowerCase());
    return values.includes(token);
  });

  return {
    content,
    nextParticipant,
    reason: match[2]?.trim() || undefined,
    privateMessages,
  };
}

export function shouldRetryEmptyMultiModelReply(
  decision: MultiModelNextSpeaker
): boolean {
  return (
    !decision.content &&
    !decision.privateMessages?.length &&
    (decision.nextParticipant !== undefined || decision.nextUser === true)
  );
}

/** 流式展示时隐藏私聊块与尚未完成的控制指令。 */
export function visibleMultiModelContent(raw: string): string {
  let visible = raw.replace(new RegExp(PRIVATE_MESSAGE_RE.source, "gi"), "");
  const privateIndex = visible.search(/\[\[private\s*:/i);
  if (privateIndex >= 0) visible = visible.slice(0, privateIndex);
  const markerIndex = visible.search(
    /\[\[(?:next_speaker|next|下一位)\s*:/i
  );
  return (markerIndex >= 0 ? visible.slice(0, markerIndex) : visible).trimEnd();
}

function appendMessage(out: Message[], message: Message): void {
  const last = out[out.length - 1];
  if (
    last &&
    last.role === "user" &&
    message.role === "user" &&
    typeof last.content === "string" &&
    typeof message.content === "string"
  ) {
    last.content = `${last.content}\n\n${message.content}`;
    return;
  }
  out.push(message);
}

/**
 * 把群组讨论记录转换成某个参与者视角下的消息序列。
 *
 * 当前参与者过去的发言是 assistant，其他所有参与者的发言作为带署名的 user。
 * 相邻 user 会合并，避免 Anthropic 因连续 user 消息拒绝请求。
 */
export function buildMultiModelMessages(
  entries: MultiModelEntry[],
  speaker: MultiModelParticipant,
  config: MultiModelConfig,
  selection: MultiModelSelectionContext = {}
): Message[] {
  const speakerId = multiModelParticipantId(speaker);
  const others = config.participants
    .filter((participant) => multiModelParticipantId(participant) !== speakerId)
    .map((participant) => participant.name);

  const messages: Message[] = [
    {
      role: "system",
      content:
        `你正在参加由 ${config.participants.length} 个模型组成的多模型讨论。` +
        `你是「${speaker.name}」（id: ${speaker.id}）。其他参与者包括：${others.join("、")}。` +
        `\n\n参与者名册，按发言顺序：\n` +
        `0. id=user；名称=用户；角色=发起人与最终决策者\n` +
        config.participants
          .map(
            (participant, index) =>
              `${index + 1}. id=${participant.id}；` +
              `名称=${participant.name}；` +
              `角色=${participant.role ?? "参与者"}`
          )
          .join("\n") +
        (selection.selectedBy
          ? `\n\n上一位发言者「${selection.selectedBy.name}」指定由你继续发言。` +
            (selection.reason ? `原因：${selection.reason}` : "")
          : "") +
        (speaker.systemPrompt?.trim()
          ? `\n你的角色说明：${speaker.systemPrompt.trim()}。`
          : "") +
        `\n\n请直接回应其他参与者的最新观点，可以补充、质疑、修正或提出下一步问题。` +
        `不要代替其他模型发言，不要替整个讨论下最终结论，不要使用自己的名字作为署名。` +
        `保持每轮发言聚焦、简洁，并持续推进用户提出的问题。` +
        `每轮回复必须包含非空公开正文，禁止只输出调度指令。` +
        `\n\n如果你希望指定下一位发言者，请在正文结束后另起一行，只输出一次：` +
        `\n[[next_speaker:参与者id|reason:简短原因]]` +
        `\n可以选择其他模型参与者，也可以选择 id=user 邀请用户发言。` +
        `需要用户补充信息、确认方案、做选择或承担决策时，请选择 user。` +
        `不指定时系统会按顺序轮转。不要解释或复述这条控制指令。` +
        `\n\n公开内容直接写在正文中，所有人可见。` +
        `如果你需要只对某位其他模型说私下内容，请使用：` +
        `\n[[private:参与者id|topic:简短主题]]` +
        `\n私聊正文` +
        `\n[[/private]]` +
        `\n私聊内容不会出现在公开正文中，但用户可以查看。可以连续输出多个私聊块。`,
    },
  ];

  for (const entry of entries) {
    if (entry.role === "user") {
      appendMessage(messages, { role: "user", content: entry.content });
      continue;
    }

    if (
      entry.channel === "private" &&
      entry.participantId !== speakerId &&
      entry.recipientId !== speakerId
    ) {
      continue;
    }

    if (entry.channel === "private") {
      const otherId =
        entry.participantId === speakerId
          ? entry.recipientId
          : entry.participantId;
      const otherName =
        config.participants.find(
          (participant) => multiModelParticipantId(participant) === otherId
        )?.name ?? "其他模型";
      appendMessage(messages, {
        role: entry.participantId === speakerId ? "assistant" : "user",
        content:
          entry.participantId === speakerId
            ? `（私聊给 ${otherName}）${entry.content}`
            : `【${otherName} 私聊你】${entry.content}`,
      });
      continue;
    }

    if (entry.participantId === speakerId) {
      appendMessage(messages, { role: "assistant", content: entry.content });
    } else {
      const speakerName =
        config.participants.find(
          (participant) =>
            multiModelParticipantId(participant) === entry.participantId
        )?.name ?? "其他模型";
      appendMessage(messages, {
        role: "user",
        content: `【${speakerName}】${entry.content}`,
      });
    }
  }

  return messages;
}
