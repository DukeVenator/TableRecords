import { ApiError } from "./api";

const NO_ANSWER = "The dashboard is not answering. Is it still running?";

export function humanMessage(error: unknown, fallback = "That did not work. Try again."): string {
  if (error instanceof ApiError) {
    if (error.status >= 500) return "The dashboard hit an error. The log has the details.";
    if (error.code === "invalid_token") return "That token did not match.";
  }
  if (error instanceof TypeError) return NO_ANSWER;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return NO_ANSWER;
  }
  if (error instanceof Error && /^[A-Z]/.test(error.message) && /[.!?]$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}
