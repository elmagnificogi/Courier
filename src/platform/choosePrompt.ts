export function buildSingleChoiceRelayPrompt(question: string, rawChoice: string): string | null {
  const value = rawChoice.trim();
  if (!value) return null;
  const singleMatch = value.match(/^([abcdABCD])(?:\s+(.+))?$/);
  if (!singleMatch) return null;
  const label = (singleMatch[1] ?? "").toUpperCase();
  const custom = (singleMatch[2] ?? "").trim();
  if (label === "D" && custom.length === 0) {
    return null;
  }
  const instruction =
    label === "A"
      ? "Choose option A."
      : label === "B"
        ? "Choose option B."
        : label === "C"
          ? "Choose option C."
          : `Use this custom answer instead of predefined options: ${custom}`;

  return [
    "You asked me to choose from your previous question.",
    `Question: ${question}`,
    `Selection: ${label}${label === "D" ? " (custom)" : ""}`,
    instruction,
    "Proceed with this selection and continue the task."
  ].join("\n");
}

export function buildMultiChoiceRelayPrompt(question: string, rawSelection: string): string | null {
  const csv = rawSelection.trim();
  if (!csv) return null;
  const tokens = csv.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const selected: Array<"A" | "B" | "C" | "D"> = [];
  let customText: string | null = null;
  for (const token of tokens) {
    if (/^[abcABC]$/.test(token)) {
      selected.push(token.toUpperCase() as "A" | "B" | "C");
      continue;
    }
    if (/^d$/i.test(token)) {
      return null;
    }
    const dCustom = token.match(/^d\s*:\s*(.+)$/i);
    if (dCustom) {
      selected.push("D");
      customText = (dCustom[1] ?? "").trim();
      if (!customText) return null;
      continue;
    }
    return null;
  }

  const dedup = Array.from(new Set(selected));
  if (dedup.length === 0) return null;
  if (dedup.includes("D") && !customText) return null;

  const customLine = customText ? `Custom D answer: ${customText}` : "";
  return [
    "You asked me to choose multiple options from your previous question.",
    `Question: ${question}`,
    `Selections: ${dedup.join(", ")}`,
    customLine,
    "Apply all selected options together and continue."
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function chooseUsageText(): string {
  return [
    "用法：",
    "- `/choose A`",
    "- `/choose B`",
    "- `/choose C`",
    "- `/choose D 你的自定义回答`",
    "- `/choose multi A,C`",
    "- `/choose multi A,C,D:你的自定义回答`"
  ].join("\n");
}
