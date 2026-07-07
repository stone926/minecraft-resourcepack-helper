import type { LocalizedMessage } from "../../../i18n/messages";

export function formatDefaultMessage(value: LocalizedMessage): string {
  return value.message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    String(value.args?.[Number(index)] ?? placeholder));
}
