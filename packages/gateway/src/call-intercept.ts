import type { SurfaceMessage, SurfaceReply } from "./envelope.js";

/**
 * Owner messages that belong to a phone call (a y/n on a call approval card,
 * or a text that steers a call in progress) are taken out of the normal turn
 * path here, after pairing has proven the sender. A running call manager
 * registers itself; with no call manager nothing is intercepted.
 */
export type OwnerMessageInterceptor = (message: SurfaceMessage) => Promise<SurfaceReply | undefined>;

const interceptors = new Set<OwnerMessageInterceptor>();

export function registerOwnerMessageInterceptor(interceptor: OwnerMessageInterceptor): () => void {
  interceptors.add(interceptor);
  return () => { interceptors.delete(interceptor); };
}

export async function interceptOwnerMessage(message: SurfaceMessage): Promise<SurfaceReply | undefined> {
  for (const interceptor of interceptors) {
    const reply = await interceptor(message);
    if (reply) return reply;
  }
  return undefined;
}
