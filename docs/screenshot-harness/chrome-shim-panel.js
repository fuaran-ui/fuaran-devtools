// Stands in for the DevTools page's chrome.* in the harness: the port speaks
// straight to the page frame's bridge listener, exactly as the background
// router would. panel.js itself is the real built artifact, untouched.
(() => {
  const bus = window.parent.__fuaranShotBus;
  window.chrome = {
    devtools: {
      inspectedWindow: { tabId: 1 },
      network: { onNavigated: { addListener: () => {} } },
    },
    runtime: {
      getURL: (file) => `../../dist/${file}`,
      connect: () => {
        const handlers = [];
        const port = {
          onMessage: { addListener: (h) => handlers.push(h) },
          onDisconnect: { addListener: () => {} },
          postMessage: (msg) => {
            const fn = bus.contentListener;
            if (fn === null) return;
            fn(msg.request, {}, (response) => handlers.forEach((h) => h(response)));
          },
          _deliver: (m) => handlers.forEach((h) => h(m)),
        };
        bus.panelPorts.push(port);
        return port;
      },
    },
  };
})();
