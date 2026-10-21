declare module "claude-code" {
  interface PluginState {
    "parkagent-guard": {
      /**
       * When the /guard off window ends, in epoch ms; 0 (the default) means the
       * guard is armed. Session-scoped: it never reaches another session, and
       * `tool.check` ignores it for a subagent's calls.
       */
      offUntil: number;
    };
  }
}
