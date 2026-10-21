// No-view command: runs, copies, shows a HUD and exits.
const { randomUUID } = require("node:crypto");
const { Clipboard, showHUD, getPreferenceValues } = require("@glide/api");

module.exports = async function generateUuid() {
  const { uppercase } = getPreferenceValues();
  const id = uppercase ? randomUUID().toUpperCase() : randomUUID();
  await Clipboard.copy(id);
  await showHUD(`Copied ${id}`);
};
