// ============================================================================
//  inspect/inject — the page-relay injection gate.
//
//  Injection is a `<script src=…>` tag pointing at the extension's
//  web-accessible copy of the page peer — the route that needs no `scripting`
//  permission. Two facts about that route shape this module:
//
//   1. The load is ASYNCHRONOUS. A `postMessage` posted in the same turn as
//      `appendChild` is delivered before the script has run, so a hello sent
//      then is not answered late — it is LOST, because the peer's listener
//      does not exist yet. The injector therefore settles only when the
//      script has loaded (or failed), and the caller sends nothing before
//      awaiting it. v0.1.1 raced exactly this way, and the first inspection
//      of every page failed.
//
//   2. The load is subject to the PAGE's Content-Security-Policy. A page
//      whose `script-src` does not admit extension URLs blocks the tag —
//      silently, unless the error event is observed. That outcome is a real,
//      distinct state for the panel to name; it is not "the page is slow",
//      and no reload will change it.
// ============================================================================

export type InjectionOutcome =
  /** The peer script ran; its listener is installed. */
  | 'ready'
  /** The script never loaded — in practice, the page's CSP refused it. */
  | 'blocked';

/** Injects once; every call returns the same settling promise thereafter. */
export type RelayInjector = () => Promise<InjectionOutcome>;

export const createRelayInjector = (doc: Document, src: string): RelayInjector => {
  let outcome: Promise<InjectionOutcome> | undefined;
  return () => {
    outcome ??= new Promise<InjectionOutcome>((resolve) => {
      const script = doc.createElement('script');
      script.src = src;
      script.async = false;
      // Remove the tag once it has settled either way: the peer's listener is
      // installed by then (or never will be), and leaving an extension URL in
      // the app's DOM would be a visible artefact of an inspector that is
      // supposed to observe without altering.
      script.addEventListener('load', () => {
        script.remove();
        resolve('ready');
      });
      script.addEventListener('error', () => {
        script.remove();
        resolve('blocked');
      });
      (doc.head ?? doc.documentElement).appendChild(script);
    });
    return outcome;
  };
};
