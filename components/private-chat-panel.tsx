import { LockKeyhole } from "lucide-react";
import { MarkdownMessage } from "@/components/markdown-message";
import {
  multiModelParticipantTone,
  type MultiModelParticipant,
} from "@/lib/sdk";
import { cn } from "@/components/ui/button";

export interface PrivateChatPanelMessage {
  id: string;
  content: string;
  sender: MultiModelParticipant;
  recipient: MultiModelParticipant;
  topic?: string;
}

export function PrivateChatPanel({
  messages,
  participants,
}: {
  messages: PrivateChatPanelMessage[];
  participants: MultiModelParticipant[];
}) {
  return (
    <aside className="dark flex w-80 shrink-0 flex-col border-l border-gray-800 bg-gray-950 text-gray-100">
      <div className="border-b border-gray-800 px-4 py-4">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-4 w-4 text-amber-400" />
          <div className="font-semibold">私聊频道</div>
          <span className="ml-auto rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
            {messages.length}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          模型之间的私聊，仅用户与收发双方可见
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
          {participants.map((participant) => {
            const tone = multiModelParticipantTone(participant.id);
            return (
              <span
                key={participant.id}
                className={cn("text-[10px]", tone.text)}
              >
                ● {participant.name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-5 text-gray-600">
            暂无模型私聊
          </div>
        ) : (
          messages.map((message) => {
            const senderTone = multiModelParticipantTone(message.sender.id);
            const recipientTone = multiModelParticipantTone(message.recipient.id);
            return (
              <div
                key={message.id}
                className={cn(
                  "rounded-md border border-gray-800 border-l-4 bg-gray-900 p-3 shadow-sm",
                  senderTone.border
                )}
              >
                <div className="flex flex-wrap items-center gap-1 text-[11px]">
                  <span className={cn("font-semibold", senderTone.text)}>
                    {message.sender.name}
                  </span>
                  <span className="text-gray-500">私聊给</span>
                  <span className={cn("font-semibold", recipientTone.text)}>
                    {message.recipient.name}
                  </span>
                  {message.topic && (
                    <span className="ml-auto rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                      {message.topic}
                    </span>
                  )}
                </div>
                <MarkdownMessage
                  content={message.content}
                  className="mt-2 text-gray-200"
                />
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
