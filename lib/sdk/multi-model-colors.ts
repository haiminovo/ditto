const PARTICIPANT_TONES = [
  {
    text: "text-sky-700 dark:text-sky-300",
    border: "border-sky-400",
    bubble: "bg-sky-50 dark:bg-sky-950/40",
  },
  {
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-400",
    bubble: "bg-emerald-50 dark:bg-emerald-950/40",
  },
  {
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-400",
    bubble: "bg-amber-50 dark:bg-amber-950/40",
  },
  {
    text: "text-fuchsia-700 dark:text-fuchsia-300",
    border: "border-fuchsia-400",
    bubble: "bg-fuchsia-50 dark:bg-fuchsia-950/40",
  },
  {
    text: "text-rose-700 dark:text-rose-300",
    border: "border-rose-400",
    bubble: "bg-rose-50 dark:bg-rose-950/40",
  },
  {
    text: "text-cyan-700 dark:text-cyan-300",
    border: "border-cyan-400",
    bubble: "bg-cyan-50 dark:bg-cyan-950/40",
  },
] as const;

export function multiModelParticipantTone(id: string): (typeof PARTICIPANT_TONES)[number] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PARTICIPANT_TONES[hash % PARTICIPANT_TONES.length];
}
