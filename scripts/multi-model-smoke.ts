/**
 * 多模型讨论消息构造与轮转调度测试。
 */

import {
  buildMultiModelMessages,
  multiModelParticipantAt,
  nextMultiModelParticipant,
  parseMultiModelNextSpeaker,
  shouldRetryEmptyMultiModelReply,
  visibleMultiModelContent,
  type MultiModelConfig,
  type MultiModelParticipant,
} from "../lib/sdk/multi-model";

let passed = 0;
let failed = 0;

function assert(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✓ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
    return;
  }
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
}

function participant(name: string): MultiModelParticipant {
  return {
    id: `participant_${name.toLowerCase()}`,
    provider: name.toLowerCase(),
    model: `${name}-model`,
    name,
  };
}

function main(): void {
  const a = participant("Alpha");
  const b = participant("Beta");
  const c = participant("Gamma");
  const config: MultiModelConfig = {
    participants: [a, b, c],
    maxTurns: 6,
  };

  assert(multiModelParticipantAt(config, 0).name === "Alpha", "第 1 次由 Alpha 发言");
  assert(multiModelParticipantAt(config, 1).name === "Beta", "第 2 次由 Beta 发言");
  assert(multiModelParticipantAt(config, 2).name === "Gamma", "第 3 次由 Gamma 发言");
  assert(multiModelParticipantAt(config, 3).name === "Alpha", "循环回到 Alpha");
  assert(nextMultiModelParticipant(config, a.id).name === "Beta", "按当前实际发言者计算下一位");
  assert(
    nextMultiModelParticipant(config, c.id).name === "Alpha",
    "跳转发言后不会回退到自己"
  );

  const entries = [
    { role: "user" as const, content: "讨论问题" },
    {
      role: "assistant" as const,
      content: "Alpha 的观点",
      participantId: "participant_alpha",
    },
    {
      role: "assistant" as const,
      content: "Beta 的反驳",
      participantId: "participant_beta",
    },
  ];

  const forAlpha = buildMultiModelMessages(entries, a, config);
  assert(forAlpha[0].role === "system", "第一条是系统提示");
  assert(
    typeof forAlpha[0].content === "string" &&
      forAlpha[0].content.includes("Beta") &&
      forAlpha[0].content.includes("Gamma"),
    "系统提示包含全部其他参与者"
  );
  assert(
    forAlpha.some(
      (message) =>
        message.role === "assistant" && message.content === "Alpha 的观点"
    ),
    "自己的历史发言保留为 assistant"
  );
  assert(
    forAlpha.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("【Beta】Beta 的反驳")
    ),
    "其他模型的历史发言带署名进入 user"
  );

  const forGamma = buildMultiModelMessages(entries, c, config);
  assert(
    forGamma.filter((message) => message.role === "user").length === 1,
    "连续的其他模型发言会合并"
  );
  assert(
    typeof forGamma[1].content === "string" &&
      forGamma[1].content.includes("Alpha 的观点") &&
      forGamma[1].content.includes("Beta 的反驳"),
    "合并后的 user 消息包含全部前序观点"
  );

  const pro = {
    id: "gpt_pro",
    provider: "openai",
    model: "gpt-4o",
    name: "GPT-4o · 正方",
    role: "正方",
  };
  const con = {
    id: "gpt_con",
    provider: "openai",
    model: "gpt-4o",
    name: "GPT-4o · 反方",
    role: "反方",
    systemPrompt: "优先指出方案风险",
  };
  const sameModelConfig: MultiModelConfig = {
    participants: [pro, con],
    maxTurns: 4,
  };
  const sameModelMessages = buildMultiModelMessages(
    [
      { role: "user", content: "开始讨论" },
      {
        role: "assistant",
        content: "正方观点",
        participantId: "gpt_pro",
      },
    ],
    con,
    sameModelConfig
  );
  assert(
    sameModelMessages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("【GPT-4o · 正方】正方观点")
    ),
    "相同模型的不同实例可以按角色正确区分"
  );
  assert(
    typeof sameModelMessages[0].content === "string" &&
      sameModelMessages[0].content.includes("优先指出方案风险"),
    "参与者角色说明进入系统提示"
  );
  assert(
    nextMultiModelParticipant(sameModelConfig, pro.id).id === con.id,
    "相同模型的不同实例仍按参与者顺序切换"
  );

  const directed = parseMultiModelNextSpeaker(
    "我的观点如下。\n[[next_speaker:participant_beta|reason:需要回应风险]]",
    config,
    "participant_alpha"
  );
  assert(directed.content === "我的观点如下。", "控制指令从展示正文中移除");
  assert(directed.nextParticipant?.name === "Beta", "按参与者 id 指定下一位");
  assert(directed.reason === "需要回应风险", "保留指定下一位的原因");
  assert(
    visibleMultiModelContent(
      "正在分析\n[[next_speaker:participant_be"
    ) === "正在分析",
    "流式过程中隐藏未完成的控制指令"
  );

  const selectedMessages = buildMultiModelMessages([], b, config, {
    selectedBy: a,
    reason: "需要 Beta 补充",
  });
  assert(
    typeof selectedMessages[0].content === "string" &&
      selectedMessages[0].content.includes("指定由你继续发言") &&
      selectedMessages[0].content.includes("需要 Beta 补充"),
    "被指定者会收到调度上下文"
  );
  assert(
    typeof selectedMessages[0].content === "string" &&
      selectedMessages[0].content.includes("[[next_speaker:参与者id|reason:简短原因]]"),
    "系统提示包含指定下一位发言者的控制协议"
  );
  assert(
    typeof selectedMessages[0].content === "string" &&
      selectedMessages[0].content.includes("id=user"),
    "参与者名册包含用户"
  );

  const userCall = parseMultiModelNextSpeaker(
    "当前信息不足。\n[[next_speaker:user|reason:请确认是否接受该风险]]",
    config,
    a.id
  );
  assert(userCall.content === "当前信息不足。", "邀请用户时隐藏控制指令");
  assert(userCall.nextUser === true, "模型可以指定用户发言");
  assert(userCall.reason === "请确认是否接受该风险", "保留邀请用户的原因");
  assert(
    shouldRetryEmptyMultiModelReply(
      parseMultiModelNextSpeaker(
        "[[next_speaker:participant_beta|reason:继续]]",
        config,
        a.id
      )
    ) === true,
    "只有调度指令时会触发自动重试"
  );
  assert(
    shouldRetryEmptyMultiModelReply(
      parseMultiModelNextSpeaker(
        "有正文\n[[next_speaker:participant_beta|reason:继续]]",
        config,
        a.id
      )
    ) === false,
    "已有公开正文时不会重复请求"
  );

  const privateDecision = parseMultiModelNextSpeaker(
    [
      "这是公开观点。",
      "[[private:participant_beta|topic:风险细节]]",
      "这条只给 Beta 看。",
      "[[/private]]",
      "[[next_speaker:participant_beta|reason:请回应私聊]]",
    ].join("\n"),
    config,
    a.id
  );
  assert(privateDecision.content === "这是公开观点。", "私聊内容不进入公开正文");
  assert(
    privateDecision.privateMessages?.[0].recipient.name === "Beta",
    "解析私聊接收者"
  );
  assert(
    privateDecision.privateMessages?.[0].content === "这条只给 Beta 看。",
    "解析私聊正文"
  );
  assert(
    privateDecision.privateMessages?.[0].topic === "风险细节",
    "保留私聊主题"
  );

  const privacyEntries = [
    { role: "user" as const, content: "开始" },
    {
      role: "assistant" as const,
      content: "公开观点",
      participantId: "participant_alpha",
      channel: "public" as const,
    },
    {
      role: "assistant" as const,
      content: "只给 Beta",
      participantId: "participant_alpha",
      recipientId: "participant_beta",
      channel: "private" as const,
    },
    {
      role: "assistant" as const,
      content: "只给 Gamma",
      participantId: "participant_alpha",
      recipientId: "participant_gamma",
      channel: "private" as const,
    },
  ];
  const betaMessages = buildMultiModelMessages(privacyEntries, b, config);
  const gammaMessages = buildMultiModelMessages(privacyEntries, c, config);
  assert(
    betaMessages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("只给 Beta") &&
        !message.content.includes("只给 Gamma")
    ),
    "私聊只进入发送者与接收者上下文"
  );
  assert(
    gammaMessages.every(
      (message) =>
        typeof message.content !== "string" ||
        !message.content.includes("只给 Beta")
    ),
    "第三方模型看不到其他模型的私聊"
  );

  console.log(`\n${"═".repeat(62)}`);
  console.log(
    failed === 0 ? `全部通过（${passed} 项断言）` : `失败 ${failed} 项，通过 ${passed} 项`
  );
  if (failed > 0) process.exitCode = 1;
}

main();
