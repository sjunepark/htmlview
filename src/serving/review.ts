import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, type Scope } from "effect";
import type { ContentListenerError } from "../errors.js";
import {
  hasExactAuthority,
  startLoopbackHttpListener,
  type LoopbackHttpListener,
} from "./listener.js";

export type ReviewOriginRole = "shell" | "content";

export interface ReviewOriginServer extends LoopbackHttpListener {
  readonly role: ReviewOriginRole;
  readonly hostname: string;
  readonly origin: string;
  readonly url: string;
  readonly readinessPath: "/.htmlview/ready";
}

function send(response: ServerResponse, status: number, message = ""): void {
  const body = Buffer.from(message);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(body);
}

function reviewHandler(hostname: string) {
  return (
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (!hasExactAuthority(request, hostname)) {
        send(response, 421, "Misdirected Request");
        return;
      }
      if (request.method === "HEAD" && request.url === "/.htmlview/ready") {
        send(response, 204);
        return;
      }
      send(response, 404, "Not Found");
    });
}

export function generateReviewHostname(
  role: ReviewOriginRole,
  random: (size: number) => Buffer = randomBytes,
): string {
  const prefix = role === "shell" ? "r" : "c";
  return `${prefix}-${random(16).toString("hex")}.localhost`;
}

export function startReviewOriginServer(
  role: ReviewOriginRole,
  options: { readonly hostname?: string } = {},
): Effect.Effect<ReviewOriginServer, ContentListenerError, Scope.Scope> {
  return Effect.gen(function* () {
    const hostname = options.hostname ?? generateReviewHostname(role);
    const listener = yield* startLoopbackHttpListener(reviewHandler(hostname));
    const origin = `http://${hostname}:${listener.port}`;
    return {
      ...listener,
      role,
      hostname,
      origin,
      url: `${origin}/`,
      readinessPath: "/.htmlview/ready",
    };
  });
}
