import type http2 from "http2";

const idleUnrefSessions = new WeakSet<http2.ClientHttp2Session>();
const activeRequestCounts = new WeakMap<http2.ClientHttp2Session, number>();

export function markH2SessionIdleUnref(session: http2.ClientHttp2Session): void {
  idleUnrefSessions.add(session);
  if ((activeRequestCounts.get(session) ?? 0) === 0) {
    session.unref();
  }
}

export function refH2SessionForActiveRequest(
  session: http2.ClientHttp2Session,
): () => void {
  if (!idleUnrefSessions.has(session)) return () => {};

  const previousActiveRequests = activeRequestCounts.get(session) ?? 0;
  activeRequestCounts.set(session, previousActiveRequests + 1);
  if (previousActiveRequests === 0) session.ref();

  let released = false;

  return () => {
    if (released) return;
    released = true;

    const activeRequests = activeRequestCounts.get(session);
    if (activeRequests === undefined || activeRequests <= 1) {
      activeRequestCounts.delete(session);
      session.unref();
      return;
    }

    activeRequestCounts.set(session, activeRequests - 1);
  };
}
