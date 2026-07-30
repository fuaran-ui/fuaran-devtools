// Stands in for the isolated world's chrome.* in the harness: getURL resolves
// into the built dist/, and messages ride the harness bus instead of the MV3
// router. content.js itself is the real built artifact, untouched.
(() => {
  const bus = window.parent.__fuaranShotBus;
  window.chrome = {
    runtime: {
      getURL: (file) => `../../dist/${file}`,
      sendMessage: (event) => {
        bus.toPanel(event);
        return Promise.resolve();
      },
      onMessage: {
        addListener: (fn) => {
          bus.contentListener = fn;
        },
      },
    },
  };
})();
