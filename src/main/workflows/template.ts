/** `{{var}}` substitution for workflow params. Missing variables become "". */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

export function substituteParams(params: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = substitute(v, vars);
  return out;
}

export type ConditionOperator = "equals" | "contains" | "startsWith" | "matches regex" | "isEmpty" | "isNotEmpty" | ">" | "<";

export const CONDITION_OPERATORS: ConditionOperator[] = ["equals", "contains", "startsWith", "matches regex", "isEmpty", "isNotEmpty", ">", "<"];

export function evaluateCondition(left: string, operator: string, right: string): boolean {
  switch (operator as ConditionOperator) {
    case "equals":
      return left === right;
    case "contains":
      return left.includes(right);
    case "startsWith":
      return left.startsWith(right);
    case "matches regex":
      try {
        return new RegExp(right).test(left);
      } catch {
        return false;
      }
    case "isEmpty":
      return left.trim() === "";
    case "isNotEmpty":
      return left.trim() !== "";
    case ">":
    case "<": {
      const a = Number(left);
      const b = Number(right);
      if (Number.isNaN(a) || Number.isNaN(b)) return operator === ">" ? left > right : left < right;
      return operator === ">" ? a > b : a < b;
    }
    default:
      return false;
  }
}

/** Built-in variables available to every run. */
export function builtinVariables(now = new Date()): Record<string, string> {
  return {
    date: now.toLocaleDateString(),
    time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    timestamp: String(now.getTime()),
  };
}
