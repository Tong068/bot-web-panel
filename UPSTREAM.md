# Upstream provenance

## Stapxs QQ Lite

- Repository: https://github.com/Stapxs/Stapxs-QQ-Lite-2.0
- Commit: `7a895b964a67faf72f912370eb769adce16e37cc`
- Author: Stapx Steve / Stapxs and contributors
- License: AGPL-3.0-only, reproduced in `LICENSE`.
- Local source used: `E:\反重力\Stapxs-QQ-Lite-2.0`.
- Unmodified styles: `web/src/upstream/css`.
- Original UI files for comparison: `web/upstream-source`.
- Adapted active components: `FriendBody.vue`, `MsgBody.vue`, `ViewerCom.vue`, `FacePan.vue`, `pages/Chat.vue`, `App.vue`, `PanelSettings.vue`, `ContextMenu.vue`.
- Settings references: original `pages/options/OptView.vue` and `OptFunction.vue` are included under `web/upstream-source`. Active settings retain their `opt-item`, `ss-switch`, `ss-radio` structures and preference keys. The six theme colors come from the pinned Border-Card-UI styles.
- Context menus follow the original message/conversation actions and `msg-menu-body` styling; the shared accessible menu, touch/keyboard handling and clipboard helper are integration code. Layout overrides are confined to `web/src/panel.css`.
- Avatar lookup, authenticated media registration, history enrichment and persisted conversation preferences are framework integration code. No guessed numeric conversion is applied to official bot IDs.
- Framework integration, authentication, storage, capability checks and account-scoped state are new. Unsupported upstream controls are omitted.

## Border-Card-UI

- Repository: https://github.com/Stapxs/Border-Card-UI
- Pinned submodule commit: `afc93141ba2fc67a25f60045d89ac707b773fe99`
- Original CSS and license: `web/public/bcui`.

## QFace

- Repository: https://github.com/koishijs/QFace
- Pinned submodule commit: `8fac1fa62c16e91e3221b439ad3f9f2f5c4b1f1d`
- PNG assets selected from the upstream metadata: `web/public/qface`.
- Original license retained beside the assets. Generated lookup: `web/src/emoji.json`.

## Integration references

QQBot-Web-Adapter was inspected for its account selection and shared Express integration. Guoba's shared-server integration was inspected. Their backend code was not copied; this plugin has its own authentication, database and adapter bridge and does not depend on either plugin.
