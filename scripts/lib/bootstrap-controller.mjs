import {
  completeBootstrapChatgpt,
  launchBrowser
} from "./chatgpt-browser-session.mjs";

export function createBootstrapController({
  launchBrowserFn = launchBrowser,
  completeBootstrapChatgptFn = completeBootstrapChatgpt
} = {}) {
  const state = {
    inProgress: false,
    lastError: "",
    startedAt: ""
  };
  let browserSession = null;

  return {
    async start(config) {
      if (browserSession) {
        return this.getSnapshot();
      }

      browserSession = await launchBrowserFn(config);
      state.inProgress = true;
      state.lastError = "";
      state.startedAt = new Date().toISOString();
      return this.getSnapshot();
    },

    async complete(config) {
      if (!browserSession) {
        throw new Error("Bootstrap has not started yet.");
      }

      try {
        await completeBootstrapChatgptFn(config, browserSession);
        state.lastError = "";
        await browserSession.close?.();
        browserSession = null;
        state.inProgress = false;
        state.startedAt = "";
        return {
          updatedConfig: config
        };
      } catch (error) {
        state.lastError = error.message;
        throw error;
      }
    },

    async close() {
      if (!browserSession) {
        state.inProgress = false;
        state.startedAt = "";
        return;
      }

      await browserSession.close?.().catch(() => null);
      browserSession = null;
      state.inProgress = false;
      state.startedAt = "";
    },

    getSnapshot() {
      return {
        ...state
      };
    }
  };
}
