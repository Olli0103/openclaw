## Unreleased

### Fixes

- Developer tooling: split root test typechecks into four serial compiler graphs, preserving test coverage and shared Vitest context while reducing the size of each checker heap.

- Codex: restore background memory narratives and isolated text completions on agent-scoped local runtimes with administrator-managed hooks, preserving managed hooks and existing native-account/proxy routing while keeping ordinary hooks and model tools isolated. (#151658)
- Sandboxes: honor each registered runtime owner's pruning policy so a stricter agent cannot evict another agent's containers or browser bridges.
- OpenRouter: configured catalog-route models keep OpenRouter's advertised reasoning efforts, so a supported `xhigh` default reaches the request instead of being lowered to `high`; custom routes and explicit reasoning opt-outs are unchanged. (#160474) Thanks @Olli0103 and @AXEG0.

### Changes

- Messaging: allow cross-provider sends and other guarded message actions by default, including WebChat-to-Discord notifications. Existing configurations that omit `tools.message.crossContext.allowAcrossProviders` adopt the new default on upgrade; explicit `false` remains enforced globally and per agent. Set `allowAcrossProviders: false` to retain provider isolation, or both it and `allowWithinProvider: false` to restrict guarded actions to the current bound conversation. See [security guidance](https://docs.openclaw.ai/gateway/security/tool-permissions#cross-provider-messaging). (#149875)
